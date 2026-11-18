import type { Speaker } from '@cue/shared';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../client';
import { type Call, calls, recordings, utterances } from '../schema';
import { getPlaybook } from './playbooks';

/**
 * Replay sessions (rows in `calls` with mode = 'replay'). OWNERSHIP RULE: every
 * function except endIdleSessions takes the caller's user id and filters by it;
 * another user's session is "not found".
 *
 * Utterances are APPEND-ONLY. Suggestions and feedback will reference them, so
 * nothing here deletes or rewrites an utterance. Seeking backward is handled by
 * ending the session and starting a new one.
 */

const isUuid = (v: string) => z.uuid().safeParse(v).success;

const ownedSession = (userId: string, callId: string) =>
  and(eq(calls.id, callId), eq(calls.userId, userId), eq(calls.mode, 'replay'));

/**
 * Start a replay of a recording, optionally with one of the user's playbooks.
 * Returns null if the recording doesn't exist, or the playbook isn't theirs.
 */
export async function createReplaySession(
  db: Db,
  userId: string,
  recordingId: string,
  positionMs = 0,
  playbookId: string | null = null,
): Promise<Call | null> {
  if (!isUuid(recordingId)) return null;
  if (playbookId !== null && !(await getPlaybook(db, userId, playbookId))) return null;
  const [recording] = await db
    .select({ id: recordings.id, title: recordings.title })
    .from(recordings)
    .where(eq(recordings.id, recordingId));
  if (!recording) return null;

  const [row] = await db
    .insert(calls)
    .values({
      userId,
      mode: 'replay',
      recordingId: recording.id,
      playbookId,
      title: recording.title,
      startedAt: sql`now()`,
      positionMs,
    })
    .returning();
  if (!row) throw new Error('session insert returned nothing');
  return row;
}

export async function getSession(db: Db, userId: string, callId: string): Promise<Call | null> {
  if (!isUuid(callId)) return null;
  const [row] = await db.select().from(calls).where(ownedSession(userId, callId));
  return row ?? null;
}

export interface SessionUtteranceInput {
  speaker: Speaker;
  text: string;
  startedMs: number;
  endedMs: number;
  confidence: number | null;
}

export interface SessionUtterance extends SessionUtteranceInput {
  id: string;
}

/**
 * Append an utterance to the caller's *live* session. Returns null (and writes
 * nothing) if the session isn't theirs or isn't live. One statement, so the
 * ownership check and the insert can't race.
 */
export async function appendSessionUtterance(
  db: Db,
  userId: string,
  callId: string,
  u: SessionUtteranceInput,
): Promise<SessionUtterance | null> {
  if (!isUuid(callId)) return null;
  const rows = await db.execute<{ id: string }>(sql`
    insert into ${utterances} (call_id, speaker, text, started_ms, ended_ms, is_final, confidence)
    select ${calls.id}, ${u.speaker}::speaker, ${u.text}, ${u.startedMs}, ${u.endedMs}, true, ${u.confidence}
    from ${calls}
    where ${calls.id} = ${callId} and ${calls.userId} = ${userId}
      and ${calls.mode} = 'replay' and ${calls.status} = 'live'
    returning id`);
  const id = rows[0]?.id;
  return id ? { id, ...u } : null;
}

/** Everything saved so far for the caller's session, in timeline order (for resume). */
export async function listSessionUtterances(
  db: Db,
  userId: string,
  callId: string,
): Promise<SessionUtterance[]> {
  if (!isUuid(callId)) return [];
  return db
    .select({
      id: utterances.id,
      speaker: utterances.speaker,
      text: utterances.text,
      startedMs: utterances.startedMs,
      endedMs: utterances.endedMs,
      confidence: utterances.confidence,
    })
    .from(utterances)
    .innerJoin(calls, eq(calls.id, utterances.callId))
    .where(ownedSession(userId, callId))
    .orderBy(asc(utterances.startedMs), asc(utterances.createdAt));
}

/** Save the playback position and mark activity. Returns false if not the caller's live session. */
export async function updateSessionPosition(
  db: Db,
  userId: string,
  callId: string,
  positionMs: number,
): Promise<boolean> {
  if (!isUuid(callId)) return false;
  const rows = await db
    .update(calls)
    .set({ positionMs: Math.max(0, Math.round(positionMs)), lastActivityAt: sql`now()` })
    .where(and(ownedSession(userId, callId), eq(calls.status, 'live')))
    .returning({ id: calls.id });
  return rows.length === 1;
}

/** End the caller's live session. Returns false if it isn't theirs or already ended. */
export async function endSession(
  db: Db,
  userId: string,
  callId: string,
  status: 'ended' | 'failed',
  positionMs?: number,
): Promise<boolean> {
  if (!isUuid(callId)) return false;
  const rows = await db
    .update(calls)
    .set({
      status,
      endedAt: sql`greatest(now(), ${calls.startedAt})`,
      lastActivityAt: sql`now()`,
      ...(positionMs === undefined ? {} : { positionMs: Math.max(0, Math.round(positionMs)) }),
    })
    .where(and(ownedSession(userId, callId), eq(calls.status, 'live')))
    .returning({ id: calls.id });
  return rows.length === 1;
}

/**
 * Cleanup job (NOT user-scoped; call only from the realtime server's timer):
 * end live sessions with no activity for longer than `idleMs`. This is the only
 * way an abandoned session is ended; shutdowns and disconnects leave sessions
 * live and paused so they can resume.
 */
export async function endIdleSessions(db: Db, idleMs: number): Promise<number> {
  const cutoff = sql`now() - make_interval(secs => ${idleMs / 1000})`;
  const rows = await db
    .update(calls)
    .set({ status: 'ended', endedAt: sql`greatest(now(), ${calls.startedAt})` })
    .where(and(eq(calls.status, 'live'), lt(calls.lastActivityAt, cutoff)))
    .returning({ id: calls.id });
  return rows.length;
}
