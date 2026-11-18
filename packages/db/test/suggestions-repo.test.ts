import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createPlaybook } from '../src/repositories/playbooks';
import {
  appendSessionUtterance,
  createReplaySession,
  endSession,
} from '../src/repositories/sessions';
import {
  createSuggestion,
  finishSuggestion,
  getSuggestion,
  setSuggestionFeedback,
  setSuggestionRendered,
} from '../src/repositories/suggestions';
import { toSuggestionTimings } from '../src/timings';
import { connectTestDb, makeRecording, makeUser } from './helpers';

const { db, close } = connectTestDb();
afterAll(close);

const t = (ms: number) => new Date(Date.UTC(2026, 10, 17, 12, 0, 0) + ms);

describe('suggestions', () => {
  let alice: string;
  let bob: string;
  let callId: string;
  let utteranceId: string;

  beforeEach(async () => {
    alice = (await makeUser(db)).id;
    bob = (await makeUser(db)).id;
    const { recordingId } = await makeRecording(db, 2);
    const s = await createReplaySession(db, alice, recordingId);
    if (!s) throw new Error('no session');
    callId = s.id;
    const u = await appendSessionUtterance(db, alice, callId, {
      speaker: 'prospect',
      text: 'It is too expensive.',
      startedMs: 0,
      endedMs: 900,
      confidence: null,
    });
    if (!u) throw new Error('no utterance');
    utteranceId = u.id;
  });

  const create = (userId: string, id = randomUUID()) =>
    createSuggestion(db, userId, {
      id,
      callId,
      utteranceId,
      model: 'test-model',
      promptVersion: 'suggest-v1',
      utteranceEndAt: t(0),
      requestSentAt: t(20),
    }).then((ok) => ({ ok, id }));

  it('records the full lifecycle with all five latency timestamps in order', async () => {
    const { ok, id } = await create(alice);
    expect(ok).toBe(true);
    expect(await getSuggestion(db, alice, id)).toMatchObject({
      status: 'streaming',
      model: 'test-model',
    });

    expect(
      await finishSuggestion(db, alice, id, {
        status: 'complete',
        text: 'Ask what the current process costs them.',
        firstTokenAt: t(300),
        lastTokenAt: t(520),
      }),
    ).toBe(true);
    expect(await setSuggestionRendered(db, alice, id, t(560))).toBe(true);

    const row = await getSuggestion(db, alice, id);
    expect(row).toMatchObject({ status: 'complete', failureReason: null });
    expect(toSuggestionTimings(row ?? ({} as never))).toEqual({
      utterance_end: t(0).getTime(),
      suggestion_request_sent: t(20).getTime(),
      first_token: t(300).getTime(),
      last_token: t(520).getTime(),
      rendered_in_client: t(560).getTime(),
    });
  });

  it('stores the failure reason and keeps the first outcome only', async () => {
    const { id } = await create(alice);
    await finishSuggestion(db, alice, id, {
      status: 'failed',
      reason: 'first_token_timeout',
      text: '',
      firstTokenAt: null,
    });
    expect(
      await finishSuggestion(db, alice, id, {
        status: 'complete',
        text: 'late',
        firstTokenAt: t(1),
        lastTokenAt: t(2),
      }),
    ).toBe(false);
    expect(await getSuggestion(db, alice, id)).toMatchObject({
      status: 'failed',
      failureReason: 'first_token_timeout',
      text: '',
    });
    // A failed suggestion can't get a render time.
    expect(await setSuggestionRendered(db, alice, id, t(9))).toBe(false);
  });

  it("won't create suggestions on another user's or a finished session", async () => {
    expect((await create(bob)).ok).toBe(false);
    await endSession(db, alice, callId, 'ended');
    expect((await create(alice)).ok).toBe(false);
  });

  it("another user can't read, finish, time or give feedback on the suggestion", async () => {
    const { id } = await create(alice);
    expect(await getSuggestion(db, bob, id)).toBeNull();
    expect(
      await finishSuggestion(db, bob, id, {
        status: 'complete',
        text: 'x',
        firstTokenAt: t(1),
        lastTokenAt: t(2),
      }),
    ).toBe(false);
    expect(await setSuggestionFeedback(db, bob, id, 'used')).toBeNull();
    expect(await getSuggestion(db, alice, id)).toMatchObject({ status: 'streaming' });
  });

  it('thumbs up and down replace each other; used is independent; repeats are harmless', async () => {
    const { id } = await create(alice);
    expect(await setSuggestionFeedback(db, alice, id, 'thumbs_up')).toEqual(['thumbs_up']);
    expect(await setSuggestionFeedback(db, alice, id, 'used')).toEqual(['thumbs_up', 'used']);
    expect(await setSuggestionFeedback(db, alice, id, 'thumbs_down')).toEqual([
      'thumbs_down',
      'used',
    ]);
    expect(await setSuggestionFeedback(db, alice, id, 'thumbs_down')).toEqual([
      'thumbs_down',
      'used',
    ]);
  });
});

describe('createReplaySession with a playbook', () => {
  it("accepts the user's own playbook and refuses someone else's", async () => {
    const alice = (await makeUser(db)).id;
    const bob = (await makeUser(db)).id;
    const { recordingId } = await makeRecording(db, 1);
    const pb = await createPlaybook(db, alice, {
      name: 'Mine',
      productDescription: 'x',
      idealCustomer: 'y',
      objections: [],
      toneNotes: null,
    });
    expect((await createReplaySession(db, alice, recordingId, 0, pb))?.playbookId).toBe(pb);
    expect(await createReplaySession(db, bob, recordingId, 0, pb)).toBeNull();
  });
});
