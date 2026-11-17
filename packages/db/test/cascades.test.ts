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
import {
  PG,
  type TestDb,
  connectTestDb,
  makeCall,
  makePlaybook,
  makeSuggestion,
  makeUser,
  makeUtterance,
  pgError,
} from './helpers';

const { db, close } = connectTestDb();
afterAll(close);

/** A user with a playbook and one call that has every kind of child row. */
async function makeFullCall(db: TestDb) {
  const user = await makeUser(db);
  const playbook = await makePlaybook(db, user.id);
  const call = await makeCall(db, user.id, playbook.id);
  const utterance = await makeUtterance(db, call.id);
  const suggestion = await makeSuggestion(db, call.id, utterance.id);
  await db.insert(suggestionFeedback).values({ suggestionId: suggestion.id, signal: 'used' });
  await db.insert(callSummaries).values({ callId: call.id, summary: 'Went well' });
  return { user, playbook, call, utterance, suggestion };
}

async function countChildren(db: TestDb, callId: string, suggestionId: string) {
  return {
    utterances: (await db.select().from(utterances).where(eq(utterances.callId, callId))).length,
    suggestions: (await db.select().from(suggestions).where(eq(suggestions.callId, callId))).length,
    feedback: (
      await db
        .select()
        .from(suggestionFeedback)
        .where(eq(suggestionFeedback.suggestionId, suggestionId))
    ).length,
    summaries: (await db.select().from(callSummaries).where(eq(callSummaries.callId, callId)))
      .length,
  };
}

describe('deleting a call', () => {
  it('removes its utterances, suggestions, feedback and summary', async () => {
    const { call, suggestion } = await makeFullCall(db);
    expect(await countChildren(db, call.id, suggestion.id)).toEqual({
      utterances: 1,
      suggestions: 1,
      feedback: 1,
      summaries: 1,
    });

    await db.delete(calls).where(eq(calls.id, call.id));

    expect(await countChildren(db, call.id, suggestion.id)).toEqual({
      utterances: 0,
      suggestions: 0,
      feedback: 0,
      summaries: 0,
    });
  });
});

describe('deleting a user', () => {
  it('removes their playbooks and calls, despite calls blocking playbook deletes', async () => {
    const { user, playbook, call } = await makeFullCall(db);

    await db.delete(users).where(eq(users.id, user.id));

    expect(await db.select().from(playbooks).where(eq(playbooks.id, playbook.id))).toEqual([]);
    expect(await db.select().from(calls).where(eq(calls.id, call.id))).toEqual([]);
  });
});

describe('deleting a playbook', () => {
  it('is refused while a call uses it', async () => {
    const { playbook } = await makeFullCall(db);
    const err = await pgError(() => db.delete(playbooks).where(eq(playbooks.id, playbook.id)));
    expect(err).toEqual({
      code: PG.foreignKeyViolation,
      constraint: 'calls_playbook_id_playbooks_id_fk',
    });
  });

  it('succeeds when no call uses it', async () => {
    const user = await makeUser(db);
    const playbook = await makePlaybook(db, user.id);
    await db.delete(playbooks).where(eq(playbooks.id, playbook.id));
    expect(await db.select().from(playbooks).where(eq(playbooks.id, playbook.id))).toEqual([]);
  });
});
