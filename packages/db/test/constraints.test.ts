import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { callSummaries, calls, suggestionFeedback, users, utterances } from '../src/schema';
import {
  PG,
  connectTestDb,
  makeCall,
  makeSuggestion,
  makeUser,
  makeUtterance,
  pgError,
} from './helpers';

const { db, close } = connectTestDb();
afterAll(close);

describe('users', () => {
  it('reject an email that differs only by case', async () => {
    const user = await makeUser(db);
    const err = await pgError(() => db.insert(users).values({ email: user.email.toUpperCase() }));
    expect(err).toEqual({ code: PG.uniqueViolation, constraint: 'users_email_lower_key' });
  });
});

describe('calls', () => {
  it('reject a status outside the enum', async () => {
    const user = await makeUser(db);
    const err = await pgError(() =>
      db.execute(sql`insert into calls (user_id, title, started_at, status)
                     values (${user.id}, 'x', now(), 'paused')`),
    );
    expect(err.code).toBe(PG.invalidTextRepresentation);
  });

  it('reject ended_at before started_at', async () => {
    const user = await makeUser(db);
    const err = await pgError(() =>
      db.insert(calls).values({
        userId: user.id,
        title: 'x',
        startedAt: new Date('2026-01-01T10:00:00Z'),
        endedAt: new Date('2026-01-01T09:00:00Z'),
      }),
    );
    expect(err).toEqual({ code: PG.checkViolation, constraint: 'calls_ended_after_started' });
  });
});

describe('utterances', () => {
  it('reject ended_ms before started_ms', async () => {
    const call = await makeCall(db, (await makeUser(db)).id);
    const err = await pgError(() =>
      db
        .insert(utterances)
        .values({ callId: call.id, speaker: 'rep', text: 'x', startedMs: 500, endedMs: 100 }),
    );
    expect(err).toEqual({ code: PG.checkViolation, constraint: 'utterances_ended_after_started' });
  });

  it('reject confidence outside 0..1', async () => {
    const call = await makeCall(db, (await makeUser(db)).id);
    const err = await pgError(() =>
      db.insert(utterances).values({
        callId: call.id,
        speaker: 'rep',
        text: 'x',
        startedMs: 0,
        endedMs: 10,
        confidence: 1.5,
      }),
    );
    expect(err).toEqual({ code: PG.checkViolation, constraint: 'utterances_confidence_range' });
  });
});

describe('suggestions', () => {
  it('reject a triggering utterance from a different call', async () => {
    const user = await makeUser(db);
    const callA = await makeCall(db, user.id);
    const callB = await makeCall(db, user.id);
    const utteranceInB = await makeUtterance(db, callB.id);

    const err = await pgError(() => makeSuggestion(db, callA.id, utteranceInB.id));
    expect(err).toEqual({
      code: PG.foreignKeyViolation,
      constraint: 'suggestions_utterance_same_call_fk',
    });
  });
});

describe('suggestion_feedback', () => {
  it('allow different signals but reject the same signal twice', async () => {
    const call = await makeCall(db, (await makeUser(db)).id);
    const suggestion = await makeSuggestion(db, call.id, (await makeUtterance(db, call.id)).id);

    await db.insert(suggestionFeedback).values([
      { suggestionId: suggestion.id, signal: 'used' },
      { suggestionId: suggestion.id, signal: 'thumbs_up' },
    ]);
    const err = await pgError(() =>
      db.insert(suggestionFeedback).values({ suggestionId: suggestion.id, signal: 'used' }),
    );
    expect(err).toEqual({
      code: PG.uniqueViolation,
      constraint: 'suggestion_feedback_suggestion_signal_key',
    });
  });
});

describe('call_summaries', () => {
  it('allow only one summary per call', async () => {
    const call = await makeCall(db, (await makeUser(db)).id);
    await db.insert(callSummaries).values({ callId: call.id, summary: 'first' });
    const err = await pgError(() =>
      db.insert(callSummaries).values({ callId: call.id, summary: 'second' }),
    );
    expect(err.code).toBe(PG.uniqueViolation);
  });

  it('default the jsonb columns to empty arrays', async () => {
    const call = await makeCall(db, (await makeUser(db)).id);
    const [row] = await db
      .insert(callSummaries)
      .values({ callId: call.id, summary: 's' })
      .returning();
    expect(row).toMatchObject({ objectionsRaised: [], nextSteps: [], coachingNotes: [] });
  });
});
