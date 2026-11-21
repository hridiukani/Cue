import type { ServerMessageBody } from '@cue/shared';
import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../clock';
import { LlmError, type LlmClient, type LlmRequest, REASONING_MAX_TOKENS } from '@cue/suggest';
import { DEFAULT_SUGGESTION_CONFIG, SuggestionEngine, type SuggestionStore } from './engine';

/**
 * Engine rules with fake time and a fake model: nothing touches the network
 * or the database.
 */

const T0 = Date.UTC(2026, 10, 17, 12, 0, 0);

/** Let promises settle (the fake clock only moves time, not microtasks). */
const flush = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/**
 * Move fake time forward in small steps, letting promises settle in between.
 * (A single big advance only fires timers that already exist; the fake model
 * schedules each next token only after the previous one has been consumed.)
 */
async function run(ms: number, step = 10) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    clock.advance(Math.min(step, ms - elapsed));
    await flush();
  }
}

type Step = { afterMs: number; delta: string } | { afterMs: number; error: LlmError };

/** A model that plays a script on the fake clock and records what it was asked. */
class ScriptedLlm implements LlmClient {
  readonly name = 'fake';
  readonly requests: { req: LlmRequest; signal: AbortSignal }[] = [];
  active = 0;
  maxActive = 0;
  constructor(
    private readonly clock: FakeClock,
    public script: Step[],
  ) {}

  async *stream(req: LlmRequest, signal: AbortSignal): AsyncIterable<string> {
    // 'In flight' = started and not aborted. (An aborted request is torn down at once.)
    const live = this.requests.filter((r) => !r.signal.aborted).length;
    this.maxActive = Math.max(this.maxActive, live + 1);
    this.requests.push({ req, signal });
    this.active++;
    try {
      for (const step of this.script) {
        await new Promise<void>((resolve, reject) => {
          const h = this.clock.setTimeout(resolve, step.afterMs);
          signal.addEventListener('abort', () => {
            this.clock.clearTimeout(h);
            reject(new LlmError('aborted', 'aborted'));
          });
        });
        if ('error' in step) throw step.error;
        yield step.delta;
      }
    } finally {
      this.active--;
    }
  }
}

class MemoryStore implements SuggestionStore {
  readonly rows = new Map<string, Record<string, unknown>>();
  /** Simulates a slow database: finish() resolves only when this is called. */
  holdFinish: Promise<void> | null = null;
  create(s: Parameters<SuggestionStore['create']>[0]) {
    this.rows.set(s.id, { ...s, status: 'streaming' });
    return Promise.resolve(true);
  }
  async finish(id: string, outcome: Parameters<SuggestionStore['finish']>[1]) {
    if (this.holdFinish) await this.holdFinish;
    const row = this.rows.get(id);
    if (row?.status !== 'streaming') return false;
    Object.assign(row, outcome);
    return true;
  }
  rendered(id: string, at: Date) {
    const row = this.rows.get(id);
    // Like the real query: only a completed suggestion can get a render time.
    if (row?.status !== 'complete') return Promise.resolve(false);
    row.clientRenderedAt = at;
    return Promise.resolve(true);
  }
}

let clock: FakeClock;
let llm: ScriptedLlm;
let store: MemoryStore;
let sent: ServerMessageBody[];
let engine: SuggestionEngine;

const words = (n: number) => Array.from({ length: n }, (_, i) => `w${String(i)} `);
const tokens = (parts: string[], everyMs = 50): Step[] =>
  parts.map((delta) => ({ afterMs: everyMs, delta }));
const of = <T extends ServerMessageBody['type']>(type: T) =>
  sent.filter((m): m is Extract<ServerMessageBody, { type: T }> => m.type === type);

function prospect(speed: '1x' | '2x' | 'instant' = '1x') {
  engine.onProspectFinal({
    utteranceId: randomUUID(),
    emittedAt: clock.now(),
    history: [{ speaker: 'prospect', text: 'It is too expensive.' }],
    speed,
  });
}

beforeEach(() => {
  clock = new FakeClock(T0);
  llm = new ScriptedLlm(clock, tokens(['Ask ', 'what it ', 'costs.'], 100));
  store = new MemoryStore();
  sent = [];
  engine = new SuggestionEngine({
    llm,
    clock,
    store,
    send: (b) => sent.push(b),
    config: { ...DEFAULT_SUGGESTION_CONFIG, model: 'test-model' },
    playbook: null,
  });
});

describe('SuggestionEngine', () => {
  it('streams a suggestion and records every timestamp relative to the utterance', async () => {
    clock.advance(20); // 20 ms between the final being emitted and the trigger
    engine.onProspectFinal({
      utteranceId: randomUUID(),
      emittedAt: T0,
      history: [{ speaker: 'prospect', text: 'It is too expensive.' }],
      speed: '1x',
    });
    await flush();
    for (let i = 0; i < 3; i++) {
      clock.advance(100);
      await flush();
    }

    expect(of('suggestionStarted')).toHaveLength(1);
    expect(of('suggestionToken').map((m) => m.text)).toEqual([
      'Ask',
      'Ask what it',
      'Ask what it costs.',
    ]);
    expect(of('suggestionCompleted')).toEqual([
      expect.objectContaining({ text: 'Ask what it costs.', firstTokenMs: 120, lastTokenMs: 320 }),
    ]);
    const [row] = [...store.rows.values()];
    expect(row).toMatchObject({
      status: 'complete',
      model: 'test-model',
      promptVersion: 'suggest-v2/no-playbook',
      utteranceEndAt: new Date(T0),
      requestSentAt: new Date(T0 + 20),
      firstTokenAt: new Date(T0 + 120),
      lastTokenAt: new Date(T0 + 320),
    });
    expect(engine.inFlight).toBe(false);
  });

  it('stores rendered_in_client as server send time + the browser-measured delay', async () => {
    prospect();
    await flush();
    await run(1000);
    const done = of('suggestionCompleted')[0];
    const id = done?.suggestionId ?? '';
    // Completed is sent at the last token: utterance end (T0) + lastTokenMs.
    const sentAt = T0 + (done?.lastTokenMs ?? 0);
    clock.advance(500); // the render report arriving late doesn't matter
    expect(await engine.onRendered(id, 16)).toBe(true);
    expect(store.rows.get(id)?.clientRenderedAt).toEqual(new Date(sentAt + 16));
    expect(await engine.onRendered(id, 16)).toBe(false); // only once
    expect(await engine.onRendered(randomUUID(), 16)).toBe(false); // unknown id
  });

  it('keeps the render time even when the browser reports before the complete write lands', async () => {
    let release: () => void = () => undefined;
    store.holdFinish = new Promise<void>((r) => (release = r));
    prospect();
    await flush();
    await run(1000);
    const id = of('suggestionCompleted')[0]?.suggestionId ?? '';
    const report = engine.onRendered(id, 9); // database still writing 'complete'
    await flush();
    expect(store.rows.get(id)?.status).toBe('streaming');
    release();
    expect(await report).toBe(true);
    expect(store.rows.get(id)?.clientRenderedAt).toBeInstanceOf(Date);
  });

  it('a newer prospect utterance cancels the one in flight; never two at once', async () => {
    prospect();
    await flush();
    clock.advance(150); // first one has one token
    await flush();
    prospect();
    await flush();
    await run(1000);

    expect(of('suggestionDropped')).toEqual([
      expect.objectContaining({ reason: 'cancelled_newer' }),
    ]);
    expect(of('suggestionCompleted')).toHaveLength(1);
    expect(llm.requests[0]?.signal.aborted).toBe(true);
    expect(llm.maxActive).toBe(1);
    const statuses = [...store.rows.values()].map((r) => [r.status, r.reason]);
    expect(statuses).toEqual([
      ['failed', 'cancelled_newer'],
      ['complete', undefined],
    ]);
  });

  describe('rep speech: backchannels are ignored, real turns cancel', () => {
    const cases: { name: string; text: string; durationMs: number; cancels: boolean }[] = [
      { name: '4 words, short', text: 'yeah that makes sense', durationMs: 900, cancels: false },
      { name: '5 words, short', text: 'yeah that makes sense so', durationMs: 900, cancels: true },
      { name: '1 word, exactly 1.5 s', text: 'mmmmhmm', durationMs: 1500, cancels: false },
      { name: '1 word, 1501 ms', text: 'mmmmhmm', durationMs: 1501, cancels: true },
    ];
    for (const c of cases) {
      it(`${c.name}: ${c.cancels ? 'cancels' : 'keeps'} the suggestion`, async () => {
        prospect();
        await flush();
        expect(engine.onRepSpeaking({ text: c.text, durationMs: c.durationMs })).toBe(c.cancels);
        await flush();
        if (c.cancels) {
          expect(of('suggestionDropped')).toEqual([
            expect.objectContaining({ reason: 'cancelled_rep_spoke' }),
          ]);
          expect(llm.requests[0]?.signal.aborted).toBe(true);
        } else {
          await run(1000);
          expect(of('suggestionDropped')).toEqual([]);
          expect(of('suggestionCompleted')).toHaveLength(1);
        }
      });
    }

    it('a growing interim cancels once it crosses a threshold', async () => {
      prospect();
      await flush();
      expect(engine.onRepSpeaking({ text: 'well', durationMs: 0 })).toBe(false);
      expect(engine.onRepSpeaking({ text: 'well I hear you', durationMs: 600 })).toBe(false);
      expect(engine.onRepSpeaking({ text: 'well I hear you but', durationMs: 900 })).toBe(true);
      await flush();
      expect(of('suggestionDropped')).toEqual([
        expect.objectContaining({ reason: 'cancelled_rep_spoke' }),
      ]);
    });

    it('does nothing when no suggestion is in flight', () => {
      expect(
        engine.onRepSpeaking({ text: 'a long reply from the rep here', durationMs: 3000 }),
      ).toBe(false);
      expect(sent).toEqual([]);
    });

    it('never cancels on rep speech when cancelOnRepSpeech is false (estimated timing)', async () => {
      engine = new SuggestionEngine({
        llm,
        clock,
        store,
        send: (b) => sent.push(b),
        config: { ...DEFAULT_SUGGESTION_CONFIG, model: 'test-model' },
        playbook: null,
        cancelOnRepSpeech: false,
      });
      prospect();
      await flush();
      expect(engine.inFlight).toBe(true);
      expect(
        engine.onRepSpeaking({ text: 'a long reply from the rep here', durationMs: 3000 }),
      ).toBe(false);
      expect(engine.inFlight).toBe(true);
      expect(sent).not.toContainEqual(expect.objectContaining({ reason: 'cancelled_rep_spoke' }));
      // Every other cancel still applies.
      engine.cancel('cancelled_stopped');
      expect(engine.inFlight).toBe(false);
    });

    it('takes custom thresholds', async () => {
      engine = new SuggestionEngine({
        llm,
        clock,
        store,
        send: (b) => sent.push(b),
        config: { ...DEFAULT_SUGGESTION_CONFIG, model: 'test-model' },
        playbook: null,
        backchannel: { maxWords: 1, maxMs: 200 },
      });
      prospect();
      await flush();
      expect(engine.onRepSpeaking({ text: 'mm hmm', durationMs: 100 })).toBe(true);
    });
  });

  it('skips suggestions entirely at instant speed', async () => {
    prospect('instant');
    await flush();
    expect(llm.requests).toHaveLength(0);
    expect(sent).toEqual([]);
  });

  it('runs at 2x', async () => {
    prospect('2x');
    await flush();
    await run(1000);
    expect(of('suggestionCompleted')).toHaveLength(1);
  });

  it('drops a suggestion whose first token takes longer than 1.5 s, and ignores late tokens', async () => {
    llm.script = [{ afterMs: 1600, delta: 'Too late.' }];
    prospect();
    await flush();
    clock.advance(1500);
    await flush();
    expect(of('suggestionDropped')).toEqual([
      expect.objectContaining({ reason: 'first_token_timeout' }),
    ]);
    clock.advance(500);
    await flush();
    expect(of('suggestionToken')).toHaveLength(0);
    expect([...store.rows.values()][0]).toMatchObject({
      status: 'failed',
      reason: 'first_token_timeout',
      firstTokenAt: null,
    });
  });

  it('drops a suggestion that starts in time but takes over 5 s overall', async () => {
    llm.script = tokens(words(6), 1000);
    prospect();
    await flush();
    for (let i = 0; i < 6; i++) {
      await run(1000);
    }
    expect(of('suggestionDropped')).toEqual([expect.objectContaining({ reason: 'timeout' })]);
    expect(of('suggestionCompleted')).toHaveLength(0);
  });

  it('on a 429, drops it and skips new suggestions until retry-after has passed', async () => {
    llm.script = [
      {
        afterMs: 50,
        error: new LlmError('rate_limited', '429', { status: 429, retryAfterMs: 3000 }),
      },
    ];
    prospect();
    await flush();
    clock.advance(50);
    await flush();
    expect(of('suggestionDropped')).toEqual([expect.objectContaining({ reason: 'rate_limited' })]);

    clock.advance(1000);
    prospect(); // still cooling down
    await flush();
    expect(llm.requests).toHaveLength(1);

    llm.script = tokens(['Ok.']);
    clock.advance(2000);
    prospect(); // cooldown over
    await flush();
    expect(llm.requests).toHaveLength(2);
  });

  it('marks other provider errors as api_error', async () => {
    llm.script = [{ afterMs: 10, error: new LlmError('http', 'HTTP 503', { status: 503 }) }];
    prospect();
    await flush();
    clock.advance(10);
    await flush();
    expect(of('suggestionDropped')).toEqual([expect.objectContaining({ reason: 'api_error' })]);
  });

  it('stops the model at 20 words instead of waiting for it to finish', async () => {
    llm.script = tokens(words(30), 10);
    prospect();
    await flush();
    for (let i = 0; i < 30; i++) {
      clock.advance(10);
      await flush();
    }
    const [done] = of('suggestionCompleted');
    expect(done?.text.split(' ')).toHaveLength(20);
    expect(llm.requests[0]?.signal.aborted).toBe(true);
  });

  it('marks output that cleans down to nothing as empty_output', async () => {
    llm.script = tokens(['  ', '""']);
    prospect();
    await flush();
    await run(200);
    expect(of('suggestionDropped')).toEqual([expect.objectContaining({ reason: 'empty_output' })]);
  });

  it('close() cancels the suggestion in flight and waits for its writes', async () => {
    prospect();
    await flush();
    await engine.close();
    expect(of('suggestionDropped')).toEqual([
      expect.objectContaining({ reason: 'cancelled_stopped' }),
    ]);
    expect([...store.rows.values()][0]).toMatchObject({
      status: 'failed',
      reason: 'cancelled_stopped',
    });
  });

  it('sends the playbook-aware prompt and request settings to the model', async () => {
    engine = new SuggestionEngine({
      llm,
      clock,
      store,
      send: (b) => sent.push(b),
      config: { ...DEFAULT_SUGGESTION_CONFIG, model: 'llama-3.1-8b-instant' },
      playbook: {
        name: 'P',
        productDescription: 'x',
        idealCustomer: 'y',
        objections: [],
        toneNotes: null,
      },
    });
    prospect();
    await flush();
    const req = llm.requests[0]?.req;
    expect(req).toMatchObject({ model: 'llama-3.1-8b-instant', maxTokens: 48, stop: ['\n'] });
    expect(req?.messages.map((m) => m.role)).toEqual(['system', 'system', 'user']);
  });

  it('gives reasoning models low effort, hidden reasoning and room to think', async () => {
    engine = new SuggestionEngine({
      llm,
      clock,
      store,
      send: (b) => sent.push(b),
      config: { ...DEFAULT_SUGGESTION_CONFIG, model: 'openai/gpt-oss-20b' },
      playbook: null,
    });
    prospect();
    await flush();
    expect(llm.requests[0]?.req).toMatchObject({
      model: 'openai/gpt-oss-20b',
      maxTokens: REASONING_MAX_TOKENS,
      reasoningEffort: 'low',
      includeReasoning: false,
    });
  });
});
