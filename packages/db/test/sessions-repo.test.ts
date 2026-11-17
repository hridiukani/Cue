import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  appendSessionUtterance,
  createReplaySession,
  endIdleSessions,
  endSession,
  getSession,
  listSessionUtterances,
  updateSessionPosition,
} from '../src/repositories/sessions';
import { calls } from '../src/schema';
import { connectTestDb, makeRecording, makeUser } from './helpers';

const { db, close } = connectTestDb();
afterAll(close);

const line = (text: string, startedMs: number) => ({
  speaker: 'rep' as const,
  text,
  startedMs,
  endedMs: startedMs + 500,
  confidence: null,
});

describe('replay sessions', () => {
  let alice: string;
  let bob: string;
  let recordingId: string;

  beforeEach(async () => {
    alice = (await makeUser(db)).id;
    bob = (await makeUser(db)).id;
    recordingId = (await makeRecording(db, 3)).recordingId;
  });

  it('creates a live replay session titled after the recording', async () => {
    const s = await createReplaySession(db, alice, recordingId, 1500);
    expect(s).toMatchObject({
      userId: alice,
      mode: 'replay',
      recordingId,
      status: 'live',
      title: 'Test recording',
      positionMs: 1500,
    });
  });

  it('refuses a missing or malformed recording id', async () => {
    expect(await createReplaySession(db, alice, randomUUID())).toBeNull();
    expect(await createReplaySession(db, alice, 'nope')).toBeNull();
  });

  it('appends utterances and lists them in timeline order', async () => {
    const s = await createReplaySession(db, alice, recordingId);
    if (!s) throw new Error('no session');
    await appendSessionUtterance(db, alice, s.id, line('second', 2000));
    await appendSessionUtterance(db, alice, s.id, line('first', 0));
    expect((await listSessionUtterances(db, alice, s.id)).map((u) => u.text)).toEqual([
      'first',
      'second',
    ]);
  });

  describe("another user's session", () => {
    it('cannot be read, appended to, moved or ended by Bob', async () => {
      const s = await createReplaySession(db, alice, recordingId);
      if (!s) throw new Error('no session');
      await appendSessionUtterance(db, alice, s.id, line('mine', 0));

      expect(await getSession(db, bob, s.id)).toBeNull();
      expect(await listSessionUtterances(db, bob, s.id)).toEqual([]);
      expect(await appendSessionUtterance(db, bob, s.id, line('injected', 100))).toBeNull();
      expect(await updateSessionPosition(db, bob, s.id, 9999)).toBe(false);
      expect(await endSession(db, bob, s.id, 'ended')).toBe(false);

      expect(await getSession(db, alice, s.id)).toMatchObject({ status: 'live', positionMs: 0 });
      expect((await listSessionUtterances(db, alice, s.id)).map((u) => u.text)).toEqual(['mine']);
    });
  });

  it('only accepts utterances while the session is live', async () => {
    const s = await createReplaySession(db, alice, recordingId);
    if (!s) throw new Error('no session');
    expect(await endSession(db, alice, s.id, 'ended', 3000)).toBe(true);
    expect(await appendSessionUtterance(db, alice, s.id, line('late', 0))).toBeNull();
    expect(await getSession(db, alice, s.id)).toMatchObject({ status: 'ended', positionMs: 3000 });
    expect(await endSession(db, alice, s.id, 'failed')).toBe(false); // already ended
  });

  it('saves the position and bumps last activity', async () => {
    const s = await createReplaySession(db, alice, recordingId);
    if (!s) throw new Error('no session');
    await db
      .update(calls)
      .set({ lastActivityAt: sql`now() - interval '2 hours'` })
      .where(eq(calls.id, s.id));
    expect(await updateSessionPosition(db, alice, s.id, 4200.6)).toBe(true);
    const after = await getSession(db, alice, s.id);
    expect(after?.positionMs).toBe(4201);
    expect(Date.now() - (after?.lastActivityAt.getTime() ?? 0)).toBeLessThan(60_000);
  });
});

describe('endIdleSessions', () => {
  it('ends only live sessions idle for longer than the cutoff', async () => {
    const user = (await makeUser(db)).id;
    const { recordingId } = await makeRecording(db, 1);
    const idle = await createReplaySession(db, user, recordingId);
    const recent = await createReplaySession(db, user, recordingId);
    const alreadyEnded = await createReplaySession(db, user, recordingId);
    if (!idle || !recent || !alreadyEnded) throw new Error('no session');

    const twoHoursAgo = sql`now() - interval '2 hours'`;
    await db.update(calls).set({ lastActivityAt: twoHoursAgo }).where(eq(calls.id, idle.id));
    await db
      .update(calls)
      .set({ lastActivityAt: twoHoursAgo, status: 'failed', endedAt: sql`now()` })
      .where(eq(calls.id, alreadyEnded.id));

    await endIdleSessions(db, 60 * 60 * 1000);

    expect((await getSession(db, user, idle.id))?.status).toBe('ended');
    expect((await getSession(db, user, recent.id))?.status).toBe('live');
    expect((await getSession(db, user, alreadyEnded.id))?.status).toBe('failed');
  });
});
