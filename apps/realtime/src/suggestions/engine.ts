import { randomUUID } from 'node:crypto';
import type { ServerMessageBody, Speed, SuggestionFailureReason } from '@cue/shared';
import type { Clock, TimerHandle } from '../clock';
import {
  type BackchannelThresholds,
  type RepSpeech,
  repSpeechCancelsSuggestion,
} from './backchannel';
import { LlmError, type LlmClient, type LlmRequest } from './llm';
import {
  buildSuggestionMessages,
  cleanSuggestion,
  MAX_SUGGESTION_WORDS,
  type PlaybookForPrompt,
  type WindowUtterance,
  wordCount,
} from './prompt';

/** Persistence for this session's suggestions, already scoped to its owner. */
export interface SuggestionStore {
  create(s: {
    id: string;
    utteranceId: string;
    model: string;
    promptVersion: string;
    utteranceEndAt: Date;
    requestSentAt: Date;
  }): Promise<boolean>;
  finish(
    id: string,
    outcome:
      | { status: 'complete'; text: string; firstTokenAt: Date; lastTokenAt: Date }
      | {
          status: 'failed';
          reason: SuggestionFailureReason;
          text: string;
          firstTokenAt: Date | null;
        },
  ): Promise<boolean>;
  rendered(id: string, at: Date): Promise<boolean>;
}

export interface SuggestionConfig {
  model: string;
  /** No first token by then (after the request is sent): drop it. Late is worse than none. */
  firstTokenTimeoutMs: number;
  /** Whole suggestion must finish by then. */
  totalTimeoutMs: number;
  maxTokens: number;
  temperature: number;
}

export const DEFAULT_SUGGESTION_CONFIG: Omit<SuggestionConfig, 'model'> = {
  firstTokenTimeoutMs: 1500,
  totalTimeoutMs: 5000,
  maxTokens: 48,
  temperature: 0.3,
};

/** Hidden-reasoning budget for reasoning models; the visible line is still capped at 20 words. */
export const REASONING_MAX_TOKENS = 512;

/** Reasoning models think in hidden tokens before writing the visible answer. */
export function isReasoningModel(model: string): boolean {
  return /(^|\/)gpt-oss/i.test(model);
}

/**
 * Per-model request settings. A reasoning model (e.g. openai/gpt-oss-20b) spends
 * tokens on hidden reasoning first: with a 48-token budget it returned no answer
 * at all (checked against Groq, 2026-11-17). So it gets low reasoning effort, a
 * larger budget, and its reasoning kept out of the stream. Generation still stops
 * early once the visible line reaches 20 words.
 */
export function modelRequestSettings(
  model: string,
  maxTokens: number,
): Pick<LlmRequest, 'maxTokens' | 'reasoningEffort' | 'includeReasoning'> {
  if (!isReasoningModel(model)) return { maxTokens };
  return {
    maxTokens: Math.max(maxTokens, REASONING_MAX_TOKENS),
    reasoningEffort: 'low',
    includeReasoning: false,
  };
}

interface Flight {
  id: string;
  abort: AbortController;
  utteranceEndAt: number;
  requestSentAt: number;
  firstTokenAt: number | null;
  lastTokenAt: number | null;
  raw: string;
  settled: boolean;
  timers: TimerHandle[];
  inserted: Promise<boolean>;
}

/**
 * Generates at most ONE suggestion at a time for one session.
 *
 * - Triggered by a saved prospect final, at 1x or 2x only (never at instant).
 * - A newer prospect final, substantial rep speech (> 4 words or > 1.5 s; short
 *   backchannels don't count), or the session stopping cancels the suggestion
 *   in flight.
 * - No first token within firstTokenTimeoutMs (1.5 s): dropped as failed. A
 *   429 drops it too and pauses suggestions for the provider's retry-after.
 *   Nothing is retried: a late suggestion is worse than none.
 * - Every stage is timestamped (see docs/latency.md). In replay, utteranceEndAt
 *   is when the transcript line was emitted: there is no speech-to-text delay.
 */
export class SuggestionEngine {
  private current: Flight | null = null;
  private cooldownUntil = 0;
  /** Server time each completed suggestion was sent, for the browser's render report. */
  private readonly completedSentAt = new Map<string, number>();
  /** The final write for each suggestion; a render report must land after it (it needs status=complete). */
  private readonly finishWrites = new Map<string, Promise<boolean>>();
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly deps: {
      llm: LlmClient;
      clock: Clock;
      store: SuggestionStore;
      send: (body: ServerMessageBody) => void;
      config: SuggestionConfig;
      playbook: PlaybookForPrompt | null;
      /** When rep speech counts as taking the turn. Defaults: > 4 words or > 1.5 s. */
      backchannel?: BackchannelThresholds;
      log?: { warn(obj: object, msg: string): void };
    },
  ) {}

  get inFlight(): boolean {
    return this.current !== null;
  }

  /** A prospect utterance was finalized and saved. */
  onProspectFinal(input: {
    utteranceId: string;
    /** Server time the final was emitted (stands in for utterance_end; see docs/latency.md). */
    emittedAt: number;
    history: readonly WindowUtterance[];
    speed: Speed;
  }): void {
    if (input.speed === 'instant') {
      this.cancel('cancelled_stopped');
      return;
    }
    if (this.deps.clock.now() < this.cooldownUntil) return; // rate limited: skip, don't queue
    this.cancel('cancelled_newer');
    this.start(input);
  }

  /**
   * The rep is talking (interim: words and time so far; final: the whole line).
   * Substantial speech makes the suggestion moot and cancels it; a short
   * backchannel ("mm-hmm", "right") doesn't (see ./backchannel.ts).
   * Returns whether it cancelled.
   */
  onRepSpeaking(speech: RepSpeech): boolean {
    if (!this.current) return false;
    if (!repSpeechCancelsSuggestion(speech, this.deps.backchannel)) return false;
    this.cancel('cancelled_rep_spoke');
    return true;
  }

  /** Cancel whatever is in flight (pause, seek, speed change, disconnect, shutdown, …). */
  cancel(reason: SuggestionFailureReason): void {
    const f = this.current;
    if (f) this.settle(f, { status: 'failed', reason });
  }

  /**
   * The browser painted a completed suggestion `renderDelayMs` after receiving
   * it (measured on the browser's own clock). Stored as server send time +
   * delay, so clock skew between browser and server can't corrupt it.
   */
  async onRendered(suggestionId: string, renderDelayMs: number): Promise<boolean> {
    const sentAt = this.completedSentAt.get(suggestionId);
    if (sentAt === undefined) return false;
    this.completedSentAt.delete(suggestionId);
    const renderedAt = new Date(sentAt + renderDelayMs);
    // A fast browser can report before our 'complete' write has landed: wait for it.
    const finished = this.finishWrites.get(suggestionId) ?? Promise.resolve(true);
    this.finishWrites.delete(suggestionId);
    return this.track(
      finished.then((ok) => (ok ? this.deps.store.rendered(suggestionId, renderedAt) : false)),
    );
  }

  /** Stop: cancel in-flight work and wait for its writes to finish. */
  async close(): Promise<void> {
    this.cancel('cancelled_stopped');
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  // ------------------------------------------------------------------ internals

  private start(input: {
    utteranceId: string;
    emittedAt: number;
    history: readonly WindowUtterance[];
  }): void {
    const { clock, config, store, send } = this.deps;
    const { messages, promptVersion } = buildSuggestionMessages({
      playbook: this.deps.playbook,
      history: input.history,
    });
    const id = randomUUID();
    const requestSentAt = clock.now();
    const flight: Flight = {
      id,
      abort: new AbortController(),
      utteranceEndAt: input.emittedAt,
      requestSentAt,
      firstTokenAt: null,
      lastTokenAt: null,
      raw: '',
      settled: false,
      timers: [],
      // Insert in parallel with the request: the database stays out of the token path.
      inserted: this.track(
        store
          .create({
            id,
            utteranceId: input.utteranceId,
            model: config.model,
            promptVersion,
            utteranceEndAt: new Date(input.emittedAt),
            requestSentAt: new Date(requestSentAt),
          })
          .catch(() => false),
      ),
    };
    this.current = flight;
    send({ type: 'suggestionStarted', suggestionId: id, utteranceId: input.utteranceId });

    flight.timers.push(
      clock.setTimeout(() => {
        if (flight.firstTokenAt === null)
          this.settle(flight, { status: 'failed', reason: 'first_token_timeout' });
      }, config.firstTokenTimeoutMs),
      clock.setTimeout(() => {
        this.settle(flight, { status: 'failed', reason: 'timeout' });
      }, config.totalTimeoutMs),
    );

    void this.track(this.consume(flight, messages));
  }

  private async consume(
    flight: Flight,
    messages: ReturnType<typeof buildSuggestionMessages>['messages'],
  ) {
    const { llm, clock, config, send } = this.deps;
    try {
      for await (const delta of llm.stream(
        {
          model: config.model,
          messages,
          temperature: config.temperature,
          stop: ['\n'],
          ...modelRequestSettings(config.model, config.maxTokens),
        },
        flight.abort.signal,
      )) {
        if (flight.settled) return;
        const now = clock.now();
        flight.firstTokenAt ??= now;
        flight.lastTokenAt = now;
        flight.raw += delta;
        send({
          type: 'suggestionToken',
          suggestionId: flight.id,
          text: cleanSuggestion(flight.raw),
        });
        // Enough words: stop generating now rather than wait for the model.
        if (wordCount(cleanSuggestion(flight.raw)) >= MAX_SUGGESTION_WORDS) break;
      }
      if (flight.settled) return;
      const text = cleanSuggestion(flight.raw);
      if (!text || flight.firstTokenAt === null || flight.lastTokenAt === null) {
        this.settle(flight, { status: 'failed', reason: 'empty_output' });
      } else {
        this.settle(flight, { status: 'complete' });
      }
    } catch (err) {
      if (flight.settled) return; // we aborted it (cancel/timeout); already recorded
      if (err instanceof LlmError && err.kind === 'rate_limited') {
        this.cooldownUntil = clock.now() + (err.opts.retryAfterMs ?? 10_000);
        this.settle(flight, { status: 'failed', reason: 'rate_limited' });
      } else {
        this.deps.log?.warn({ err }, 'suggestion request failed');
        this.settle(flight, { status: 'failed', reason: 'api_error' });
      }
    }
  }

  /** Record the outcome exactly once: stop timers and the request, tell the browser, save. */
  private settle(
    flight: Flight,
    outcome: { status: 'complete' } | { status: 'failed'; reason: SuggestionFailureReason },
  ): void {
    if (flight.settled) return;
    flight.settled = true;
    for (const t of flight.timers) this.deps.clock.clearTimeout(t);
    flight.abort.abort();
    if (this.current === flight) this.current = null;

    const { send, store, clock } = this.deps;
    const text = cleanSuggestion(flight.raw);
    let save: Parameters<SuggestionStore['finish']>[1];
    if (
      outcome.status === 'complete' &&
      flight.firstTokenAt !== null &&
      flight.lastTokenAt !== null
    ) {
      send({
        type: 'suggestionCompleted',
        suggestionId: flight.id,
        text,
        firstTokenMs: Math.max(0, flight.firstTokenAt - flight.utteranceEndAt),
        lastTokenMs: Math.max(0, flight.lastTokenAt - flight.utteranceEndAt),
      });
      this.completedSentAt.set(flight.id, clock.now());
      save = {
        status: 'complete',
        text,
        firstTokenAt: new Date(flight.firstTokenAt),
        lastTokenAt: new Date(flight.lastTokenAt),
      };
    } else {
      const reason = outcome.status === 'failed' ? outcome.reason : 'empty_output';
      send({ type: 'suggestionDropped', suggestionId: flight.id, reason });
      save = {
        status: 'failed',
        reason,
        text,
        firstTokenAt: flight.firstTokenAt === null ? null : new Date(flight.firstTokenAt),
      };
    }
    const write = this.track(
      flight.inserted.then((ok) => (ok ? store.finish(flight.id, save) : false)).catch(() => false),
    );
    this.finishWrites.set(flight.id, write);
    void write.finally(() => {
      // Keep it only as long as a render report might still need it.
      if (outcome.status !== 'complete') this.finishWrites.delete(flight.id);
    });
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p)).catch(() => undefined);
    return p;
  }
}
