import { CoachingNotesSchema } from '@cue/shared';
import { sql } from 'drizzle-orm';
import type { Db } from './client';
import {
  callSummaries,
  calls,
  playbooks,
  suggestionFeedback,
  suggestions,
  users,
  utterances,
} from './schema';
import {
  DEMO_CALL,
  DEMO_COACHING_NOTES,
  DEMO_PLAYBOOK,
  DEMO_PROMPT_VERSION,
  DEMO_SEED_MODEL,
  DEMO_SUGGESTIONS,
  DEMO_SUMMARY,
  DEMO_USER,
  DEMO_UTTERANCES,
} from './seed-data';

export interface SeedResult {
  userId: string;
  playbookId: string;
  callId: string;
  utterances: number;
  suggestions: number;
  feedback: number;
}

/**
 * Replace the demo user's data with a fresh copy, in one transaction.
 * Idempotent: deleting the demo user cascades to everything it owns, so
 * running this twice leaves exactly one demo playbook and call.
 */
export async function seedDemo(db: Db): Promise<SeedResult> {
  return db.transaction(async (tx) => {
    await tx.delete(users).where(sql`lower(${users.email}) = lower(${DEMO_USER.email})`);

    const [user] = await tx.insert(users).values(DEMO_USER).returning({ id: users.id });
    if (!user) throw new Error('seed: user insert returned nothing');

    const [playbook] = await tx
      .insert(playbooks)
      .values({ ...DEMO_PLAYBOOK, objections: [...DEMO_PLAYBOOK.objections], userId: user.id })
      .returning({ id: playbooks.id });
    if (!playbook) throw new Error('seed: playbook insert returned nothing');

    const [call] = await tx
      .insert(calls)
      .values({ ...DEMO_CALL, userId: user.id, playbookId: playbook.id })
      .returning({ id: calls.id });
    if (!call) throw new Error('seed: call insert returned nothing');

    const utteranceRows = await tx
      .insert(utterances)
      .values(DEMO_UTTERANCES.map((u) => ({ ...u, callId: call.id })))
      .returning({ id: utterances.id, endedMs: utterances.endedMs });
    const utteranceAt = (index: number) => {
      const row = utteranceRows[index];
      if (!row) throw new Error(`seed: no utterance at index ${index}`);
      return row;
    };

    let feedbackCount = 0;
    for (const s of DEMO_SUGGESTIONS) {
      const trigger = utteranceAt(s.utteranceIndex);
      const end = DEMO_CALL.startedAt.getTime() + trigger.endedMs;
      const [suggestion] = await tx
        .insert(suggestions)
        .values({
          callId: call.id,
          utteranceId: trigger.id,
          text: s.text,
          model: DEMO_SEED_MODEL,
          promptVersion: DEMO_PROMPT_VERSION,
          status: 'complete',
          utteranceEndAt: new Date(end),
          requestSentAt: new Date(end + s.offsets.requestSent),
          firstTokenAt: new Date(end + s.offsets.firstToken),
          lastTokenAt: new Date(end + s.offsets.lastToken),
          clientRenderedAt: new Date(end + s.offsets.clientRendered),
        })
        .returning({ id: suggestions.id });
      if (!suggestion) throw new Error('seed: suggestion insert returned nothing');

      await tx
        .insert(suggestionFeedback)
        .values(s.feedback.map((signal) => ({ suggestionId: suggestion.id, signal })));
      feedbackCount += s.feedback.length;
    }

    const coachingNotes = CoachingNotesSchema.parse(
      DEMO_COACHING_NOTES.map((n) =>
        'utteranceIndex' in n
          ? { note: n.note, utterance_id: utteranceAt(n.utteranceIndex).id }
          : { note: n.note },
      ),
    );
    await tx.insert(callSummaries).values({
      callId: call.id,
      summary: DEMO_SUMMARY.summary,
      objectionsRaised: DEMO_SUMMARY.objectionsRaised,
      nextSteps: DEMO_SUMMARY.nextSteps,
      coachingNotes,
    });

    return {
      userId: user.id,
      playbookId: playbook.id,
      callId: call.id,
      utterances: utteranceRows.length,
      suggestions: DEMO_SUGGESTIONS.length,
      feedback: feedbackCount,
    };
  });
}
