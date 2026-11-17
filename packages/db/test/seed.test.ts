import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import {
  callSummaries,
  calls,
  playbooks,
  suggestionFeedback,
  suggestions,
  users,
  utterances,
} from '../src/schema';
import { DEMO_SEED_MODEL, DEMO_USER } from '../src/seed-data';
import { seedDemo } from '../src/seed';
import { toSuggestionTimings } from '../src/timings';
import { connectTestDb } from './helpers';

const { db, close } = connectTestDb();
afterAll(close);

describe('seedDemo', () => {
  it('is idempotent: two runs leave exactly one demo user, playbook and call', async () => {
    await seedDemo(db);
    const result = await seedDemo(db);

    const demoUsers = await db.select().from(users).where(eq(users.email, DEMO_USER.email));
    expect(demoUsers).toHaveLength(1);
    expect(
      await db.select().from(playbooks).where(eq(playbooks.userId, result.userId)),
    ).toHaveLength(1);
    expect(await db.select().from(calls).where(eq(calls.userId, result.userId))).toHaveLength(1);
  });

  it('populates the call fully, with valid ordered latency timings', async () => {
    const result = await seedDemo(db);

    const utts = await db.select().from(utterances).where(eq(utterances.callId, result.callId));
    expect(utts).toHaveLength(result.utterances);
    expect(new Set(utts.map((u) => u.speaker))).toEqual(new Set(['rep', 'prospect']));

    const sugs = await db.select().from(suggestions).where(eq(suggestions.callId, result.callId));
    expect(sugs).toHaveLength(result.suggestions);
    for (const s of sugs) {
      expect(s.status).toBe('complete');
      expect(s.model).toBe(DEMO_SEED_MODEL); // marks the timings as fake demo data
      expect(toSuggestionTimings(s)).not.toBeNull();
    }

    const feedback = await db
      .select()
      .from(suggestionFeedback)
      .innerJoin(suggestions, eq(suggestionFeedback.suggestionId, suggestions.id))
      .where(eq(suggestions.callId, result.callId));
    expect(feedback).toHaveLength(result.feedback);

    const [summary] = await db
      .select()
      .from(callSummaries)
      .where(eq(callSummaries.callId, result.callId));
    expect(summary?.objectionsRaised.length).toBeGreaterThan(0);
    expect(summary?.nextSteps.length).toBeGreaterThan(0);
    const utteranceIds = new Set(utts.map((u) => u.id));
    const pinned = summary?.coachingNotes.filter((n) => n.utterance_id !== undefined) ?? [];
    expect(pinned.length).toBeGreaterThan(0);
    for (const n of pinned) expect(utteranceIds.has(n.utterance_id ?? '')).toBe(true);
  });
});
