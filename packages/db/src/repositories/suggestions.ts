import type { FeedbackSignal, SuggestionFailureReason } from '@cue/shared';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../client';
import { calls, type Suggestion, suggestionFeedback, suggestions } from '../schema';

/**
 * Suggestions and their feedback. OWNERSHIP RULE: a suggestion belongs to the
 * user who owns its session (calls.user_id); every function here takes that
 * user id and touches nothing else.
 *
 * LATENCY: the four server timestamps are measured by the realtime server
 * (its clock) and passed in; see docs/latency.md. Writes are kept to two per
 * suggestion (insert at request time, one update at the end) so the database
 * stays out of the token path.
 */

const isUuid = (v: string) => z.uuid().safeParse(v).success;

/** SQL condition: the suggestion's session is owned by `userId`. */
const ownedBy = (userId: string) =>
  sql`exists (select 1 from ${calls} where ${calls.id} = ${suggestions.callId} and ${calls.userId} = ${userId})`;

export interface NewSuggestionInput {
  /** Chosen by the caller so tokens can be streamed before the insert finishes. */
  id: string;
  callId: string;
  utteranceId: string;
  model: string;
  promptVersion: string;
  utteranceEndAt: Date;
  requestSentAt: Date;
}

/** Record a suggestion as 'streaming'. False if the session isn't the caller's live session. */
export async function createSuggestion(
  db: Db,
  userId: string,
  s: NewSuggestionInput,
): Promise<boolean> {
  if (!isUuid(s.callId) || !isUuid(s.id)) return false;
  const rows = await db.execute<{ id: string }>(sql`
    insert into ${suggestions}
      (id, call_id, utterance_id, model, prompt_version, status, utterance_end_at, request_sent_at)
    select ${s.id}, ${calls.id}, ${s.utteranceId}, ${s.model}, ${s.promptVersion}, 'streaming',
           ${s.utteranceEndAt.toISOString()}::timestamptz, ${s.requestSentAt.toISOString()}::timestamptz
    from ${calls}
    where ${calls.id} = ${s.callId} and ${calls.userId} = ${userId} and ${calls.status} = 'live'
    returning id`);
  return rows.length === 1;
}

export type SuggestionOutcome =
  | { status: 'complete'; text: string; firstTokenAt: Date; lastTokenAt: Date }
  | { status: 'failed'; reason: SuggestionFailureReason; text: string; firstTokenAt: Date | null };

/** Finish a streaming suggestion (complete or failed). Only the first outcome sticks. */
export async function finishSuggestion(
  db: Db,
  userId: string,
  suggestionId: string,
  outcome: SuggestionOutcome,
): Promise<boolean> {
  if (!isUuid(suggestionId)) return false;
  const rows = await db
    .update(suggestions)
    .set(
      outcome.status === 'complete'
        ? {
            status: 'complete',
            text: outcome.text,
            firstTokenAt: outcome.firstTokenAt,
            lastTokenAt: outcome.lastTokenAt,
            failureReason: null,
          }
        : {
            status: 'failed',
            text: outcome.text,
            firstTokenAt: outcome.firstTokenAt,
            failureReason: outcome.reason,
          },
    )
    .where(
      and(eq(suggestions.id, suggestionId), eq(suggestions.status, 'streaming'), ownedBy(userId)),
    )
    .returning({ id: suggestions.id });
  return rows.length === 1;
}

/** Record when the browser painted a completed suggestion. Set once, completed suggestions only. */
export async function setSuggestionRendered(
  db: Db,
  userId: string,
  suggestionId: string,
  renderedAt: Date,
): Promise<boolean> {
  if (!isUuid(suggestionId)) return false;
  const rows = await db
    .update(suggestions)
    .set({ clientRenderedAt: renderedAt })
    .where(
      and(
        eq(suggestions.id, suggestionId),
        eq(suggestions.status, 'complete'),
        isNull(suggestions.clientRenderedAt),
        ownedBy(userId),
      ),
    )
    .returning({ id: suggestions.id });
  return rows.length === 1;
}

export async function getSuggestion(
  db: Db,
  userId: string,
  suggestionId: string,
): Promise<Suggestion | null> {
  if (!isUuid(suggestionId)) return null;
  const [row] = await db
    .select()
    .from(suggestions)
    .where(and(eq(suggestions.id, suggestionId), ownedBy(userId)));
  return row ?? null;
}

/**
 * Add a feedback signal. Thumbs up and thumbs down replace each other; "used"
 * is independent. Idempotent. Returns the suggestion's signals afterwards, or
 * null if the suggestion isn't the caller's.
 */
export async function setSuggestionFeedback(
  db: Db,
  userId: string,
  suggestionId: string,
  signal: FeedbackSignal,
): Promise<FeedbackSignal[] | null> {
  if (!(await getSuggestion(db, userId, suggestionId))) return null;
  return db.transaction(async (tx) => {
    const opposite =
      signal === 'thumbs_up' ? 'thumbs_down' : signal === 'thumbs_down' ? 'thumbs_up' : null;
    if (opposite) {
      await tx
        .delete(suggestionFeedback)
        .where(
          and(
            eq(suggestionFeedback.suggestionId, suggestionId),
            eq(suggestionFeedback.signal, opposite),
          ),
        );
    }
    await tx.insert(suggestionFeedback).values({ suggestionId, signal }).onConflictDoNothing();
    const rows = await tx
      .select({ signal: suggestionFeedback.signal })
      .from(suggestionFeedback)
      .where(
        and(
          eq(suggestionFeedback.suggestionId, suggestionId),
          inArray(suggestionFeedback.signal, ['thumbs_up', 'thumbs_down', 'used']),
        ),
      );
    const order: FeedbackSignal[] = ['thumbs_up', 'thumbs_down', 'used'];
    return order.filter((s) => rows.some((r) => r.signal === s));
  });
}
