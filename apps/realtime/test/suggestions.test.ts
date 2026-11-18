import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  createDb,
  createPlaybook,
  type Db,
  getSuggestion,
  listSessionUtterances,
  schema,
  toSuggestionTimings,
  upsertDataset,
  upsertRecording,
} from '@cue/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { Client, makeUser, startServer } from './helpers';

/**
 * The full suggestion path, offline: fixture recording → replay session →
 * SuggestionEngine → the REAL GroqClient → a mock Groq HTTP server that
 * streams SSE → browser WebSocket → Postgres.
 */

// ---------------------------------------------------------------- mock Groq

interface MockBehavior {
  firstTokenDelayMs: number;
  tokens: string[];
  gapMs: number;
  status?: number;
}

class MockGroq {
  behavior: MockBehavior = {
    firstTokenDelayMs: 40,
    tokens: ['Ask ', 'what it ', 'costs today.'],
    gapMs: 20,
  };
  readonly requests: { body: Record<string, unknown>; auth: string | undefined }[] = [];
  private server: Server | null = null;
  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      req.on('end', () => {
        this.requests.push({
          body: JSON.parse(raw) as Record<string, unknown>,
          auth: req.headers.authorization,
        });
        const b = this.behavior;
        if (b.status && b.status !== 200) {
          res.writeHead(b.status, { 'retry-after': '5' }).end('{"error":{"message":"nope"}}');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const conn = { closed: false }; // set when the client aborts
        res.on('close', () => (conn.closed = true));
        void (async () => {
          await sleep(b.firstTokenDelayMs);
          for (const t of b.tokens) {
            if (conn.closed) return;
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
            await sleep(b.gapMs);
          }
          if (!conn.closed) res.end('data: [DONE]\n\n');
        })();
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, '127.0.0.1', r));
    const { port } = this.server.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${String(port)}/openai/v1`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((r) => {
      this.server?.closeAllConnections();
      this.server?.close(() => {
        r();
      });
    });
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- fixtures

const CONVERSATION = [
  { speaker: 'rep' as const, text: 'hi this is sam from tallyforge', startedMs: 0, endedMs: 300 },
  {
    speaker: 'prospect' as const,
    text: 'honestly it is too expensive for us',
    startedMs: 400,
    endedMs: 1000,
  },
  { speaker: 'rep' as const, text: 'i understand', startedMs: 2200, endedMs: 2500 },
  {
    speaker: 'prospect' as const,
    text: 'we tried a tool before and it failed',
    startedMs: 2700,
    endedMs: 3200,
  },
  { speaker: 'rep' as const, text: 'what went wrong', startedMs: 4000, endedMs: 4300 },
];
/** A prospect line followed by a long silence: nothing cancels the suggestion but its own timeout. */
const LONG_SILENCE = [
  { speaker: 'rep' as const, text: 'hi there', startedMs: 0, endedMs: 300 },
  { speaker: 'prospect' as const, text: 'what does it cost', startedMs: 400, endedMs: 900 },
  { speaker: 'rep' as const, text: 'good question', startedMs: 9000, endedMs: 9300 },
];

let db: Db;
let closeDb: () => Promise<void>;
let mock: MockGroq;
let conversationId: string;
let silenceId: string;

beforeAll(async () => {
  ({ db, close: closeDb } = createDb(inject('testDatabaseUrl')));
  const datasetId = `test/${randomUUID()}`;
  await upsertDataset(db, {
    id: datasetId,
    name: 'Fixture',
    url: 'u',
    license: 'mit',
    revision: null,
  });
  const rec = (externalId: string, utterances: typeof CONVERSATION) =>
    upsertRecording(db, {
      datasetId,
      externalId,
      title: externalId,
      timing: 'real',
      hasAudio: false,
      language: 'en',
      metadata: {},
      utterances,
    });
  conversationId = await rec('conversation', CONVERSATION);
  silenceId = await rec('long-silence', LONG_SILENCE);
  mock = new MockGroq();
  await mock.start();
});
afterAll(async () => {
  await mock.stop();
  await closeDb();
});
beforeEach(() => {
  mock.behavior = {
    firstTokenDelayMs: 40,
    tokens: ['Ask ', 'what it ', 'costs today.'],
    gapMs: 20,
  };
  mock.requests.length = 0;
});

function startWithGroq() {
  return startServer(db, {
    env: { GROQ_API_KEY: 'gsk_test', GROQ_MODEL: 'test-model', GROQ_BASE_URL: mock.baseUrl },
  });
}

async function makePlaybook(userId: string) {
  return createPlaybook(db, userId, {
    name: 'Fixture playbook',
    productDescription: 'Tallyforge automates invoice matching.',
    idealCustomer: 'Mid-market finance teams.',
    objections: [
      { objection: 'Too expensive', good_response: 'Compare it to the cost of manual matching.' },
    ],
    toneNotes: 'Consultative.',
  });
}

// ---------------------------------------------------------------- tests

describe('suggestions end to end (replay + mocked LLM)', () => {
  it('streams a suggestion per prospect line, saves all five timestamps, and records feedback', async () => {
    const { server, url } = await startWithGroq();
    try {
      const user = await makeUser(db);
      const playbookId = await makePlaybook(user);
      const c = await new Client(url).hello(user);
      c.send({ type: 'start', recordingId: conversationId, speed: '2x', playbookId });

      await c.waitFor(() => c.of('suggestionCompleted').length >= 1, 'first suggestion');
      const [first] = c.of('suggestionCompleted');
      if (!first) throw new Error('no suggestion');
      expect(first.text).toBe('Ask what it costs today.');
      // The browser reports how long it took to paint, then gives feedback.
      c.send({ type: 'suggestionRendered', suggestionId: first.suggestionId, renderDelayMs: 12 });
      c.send({ type: 'feedback', suggestionId: first.suggestionId, signal: 'thumbs_up' });
      c.send({ type: 'feedback', suggestionId: first.suggestionId, signal: 'used' });
      await c.waitFor(() => c.of('feedbackSaved').length === 2, 'feedback saved');
      expect(c.of('feedbackSaved').at(-1)?.signals).toEqual(['thumbs_up', 'used']);

      await c.waitFor(() => c.of('state').some((s) => s.state === 'ended'), 'ended', 10_000);
      const sessionId = c.of('session')[0]?.sessionId ?? '';
      expect(c.of('session')[0]?.suggestions).toEqual({
        available: true,
        model: 'test-model',
        playbook: 'Fixture playbook',
      });

      // One suggestion per prospect line, triggered by that line (after it was saved).
      const prospectLines = (await listSessionUtterances(db, user, sessionId)).filter(
        (u) => u.speaker === 'prospect',
      );
      const started = c.of('suggestionStarted');
      expect(started.map((s) => s.utteranceId)).toEqual(prospectLines.map((u) => u.id));
      expect(c.of('suggestionCompleted')).toHaveLength(2);
      const finalIdx = c.messages.findIndex(
        (m) => m.type === 'final' && m.utteranceId === prospectLines[0]?.id,
      );
      expect(c.messages.findIndex((m) => m.type === 'suggestionStarted')).toBeGreaterThan(finalIdx);
      // Tokens stream before completion.
      const tokenTexts = c
        .of('suggestionToken')
        .filter((t) => t.suggestionId === first.suggestionId)
        .map((t) => t.text);
      expect(tokenTexts).toEqual(['Ask', 'Ask what it', 'Ask what it costs today.']);

      // Database: complete, versioned, with all five timestamps in order.
      const row = await getSuggestion(db, user, first.suggestionId);
      expect(row).toMatchObject({
        status: 'complete',
        model: 'test-model',
        promptVersion: 'suggest-v1',
        failureReason: null,
      });
      const timings = toSuggestionTimings(row ?? ({} as never));
      expect(timings).not.toBeNull();
      expect((timings?.first_token ?? 0) - (timings?.utterance_end ?? 0)).toBe(first.firstTokenMs);
      const feedback = await db
        .select({ signal: schema.suggestionFeedback.signal })
        .from(schema.suggestionFeedback)
        .where(eq(schema.suggestionFeedback.suggestionId, first.suggestionId));
      expect(feedback.map((f) => f.signal).sort()).toEqual(['thumbs_up', 'used']);

      // What the model was sent: static system prompt first, then playbook, then the window.
      const req = mock.requests[0];
      expect(req?.auth).toBe('Bearer gsk_test');
      expect(req?.body).toMatchObject({
        model: 'test-model',
        stream: true,
        max_completion_tokens: 48,
      });
      const messages = req?.body.messages as { role: string; content: string }[];
      expect(messages[0]?.content.startsWith('You are Cue')).toBe(true);
      expect(messages[1]?.content).toContain(
        '"Too expensive" → Compare it to the cost of manual matching.',
      );
      expect(
        messages[2]?.content
          .split('\n')
          .filter((l) => /^(Rep|Prospect):/.test(l))
          .at(-1),
      ).toBe('Prospect: honestly it is too expensive for us');
      c.close();

      // Another user can't give feedback on it.
      const bob = await new Client(url).hello(await makeUser(db));
      bob.send({ type: 'feedback', suggestionId: first.suggestionId, signal: 'thumbs_down' });
      await bob.waitFor(() => bob.of('error').length === 1, 'error');
      expect(bob.of('error')[0]?.code).toBe('not_found');
      bob.close();
    } finally {
      await server.app.close();
    }
  });

  it('never calls the model at instant speed', async () => {
    const { server, url } = await startWithGroq();
    try {
      const c = await new Client(url).hello(await makeUser(db));
      c.send({ type: 'start', recordingId: conversationId, speed: 'instant' });
      await c.waitFor(() => c.of('state').some((s) => s.state === 'ended'), 'ended');
      expect(c.messages.some((m) => m.type.startsWith('suggestion'))).toBe(false);
      expect(mock.requests).toHaveLength(0);
      c.close();
    } finally {
      await server.app.close();
    }
  });

  it('drops a suggestion whose first token misses the 1.5 s deadline and marks it failed', async () => {
    mock.behavior = { firstTokenDelayMs: 2500, tokens: ['Too late.'], gapMs: 10 };
    const { server, url } = await startWithGroq();
    try {
      const user = await makeUser(db);
      const c = await new Client(url).hello(user);
      c.send({ type: 'start', recordingId: silenceId, speed: '1x' });
      await c.waitFor(() => c.of('suggestionDropped').length === 1, 'dropped', 6000);
      const [dropped] = c.of('suggestionDropped');
      expect(dropped?.reason).toBe('first_token_timeout');
      await sleep(1200); // the late token would have arrived by now
      expect(c.of('suggestionToken')).toHaveLength(0);
      await sleep(100);
      expect(await getSuggestion(db, user, dropped?.suggestionId ?? '')).toMatchObject({
        status: 'failed',
        failureReason: 'first_token_timeout',
        firstTokenAt: null,
      });
      c.close();
    } finally {
      await server.app.close();
    }
  });

  it('cancels the suggestion when the rep starts talking over it', async () => {
    mock.behavior = {
      firstTokenDelayMs: 100,
      tokens: ['one ', 'two ', 'three ', 'four '],
      gapMs: 400,
    };
    const { server, url } = await startWithGroq();
    try {
      const c = await new Client(url).hello(await makeUser(db));
      c.send({ type: 'start', recordingId: conversationId, speed: '2x' });
      // At 2x the prospect finishes at 0.5 s and the rep starts at 1.1 s, mid-suggestion.
      await c.waitFor(() => c.of('suggestionDropped').length >= 1, 'dropped');
      expect(c.of('suggestionDropped')[0]?.reason).toBe('cancelled_rep_spoke');
      c.close();
    } finally {
      await server.app.close();
    }
  });

  it('drops on a provider error instead of retrying', async () => {
    mock.behavior = { firstTokenDelayMs: 0, tokens: [], gapMs: 0, status: 429 };
    const { server, url } = await startWithGroq();
    try {
      const c = await new Client(url).hello(await makeUser(db));
      c.send({ type: 'start', recordingId: silenceId, speed: '1x' });
      await c.waitFor(() => c.of('suggestionDropped').length === 1, 'dropped');
      expect(c.of('suggestionDropped')[0]?.reason).toBe('rate_limited');
      expect(mock.requests).toHaveLength(1);
      c.close();
    } finally {
      await server.app.close();
    }
  });

  it('runs without suggestions (and says so) when no LLM is configured', async () => {
    const { server, url } = await startServer(db, { llm: null });
    try {
      const c = await new Client(url).hello(await makeUser(db));
      c.send({ type: 'start', recordingId: conversationId, speed: '2x' });
      await c.waitFor(() => c.of('state').some((s) => s.state === 'ended'), 'ended', 10_000);
      expect(c.of('session')[0]?.suggestions).toEqual({
        available: false,
        model: null,
        playbook: null,
      });
      expect(c.messages.some((m) => m.type.startsWith('suggestion'))).toBe(false);
      c.close();
    } finally {
      await server.app.close();
    }
  });
});
