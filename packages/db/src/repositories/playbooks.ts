import type { PlaybookInput } from '@cue/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../client';
import { getPgError, PG_ERROR } from '../errors';
import { type Playbook, playbooks } from '../schema';

/**
 * Playbook data access. OWNERSHIP RULE: every query filters by both the
 * playbook id AND the caller's user id. A playbook owned by someone else is
 * indistinguishable from one that doesn't exist, so callers never learn that
 * another user's id is valid.
 */

export interface PlaybookListItem {
  id: string;
  name: string;
  idealCustomer: string;
  objectionCount: number;
  updatedAt: Date;
}

const isUuid = (value: string) => z.uuid().safeParse(value).success;

const ownedBy = (userId: string, playbookId: string) =>
  and(eq(playbooks.id, playbookId), eq(playbooks.userId, userId));

export async function listPlaybooks(db: Db, userId: string): Promise<PlaybookListItem[]> {
  return db
    .select({
      id: playbooks.id,
      name: playbooks.name,
      idealCustomer: playbooks.idealCustomer,
      objectionCount: sql<number>`jsonb_array_length(${playbooks.objections})::int`,
      updatedAt: playbooks.updatedAt,
    })
    .from(playbooks)
    .where(eq(playbooks.userId, userId))
    .orderBy(desc(playbooks.updatedAt));
}

export async function getPlaybook(
  db: Db,
  userId: string,
  playbookId: string,
): Promise<Playbook | null> {
  if (!isUuid(playbookId)) return null;
  const [row] = await db.select().from(playbooks).where(ownedBy(userId, playbookId));
  return row ?? null;
}

export async function createPlaybook(
  db: Db,
  userId: string,
  input: PlaybookInput,
): Promise<string> {
  const [row] = await db
    .insert(playbooks)
    .values({ ...input, userId })
    .returning({ id: playbooks.id });
  if (!row) throw new Error('playbook insert returned nothing');
  return row.id;
}

/** Returns false if the playbook doesn't exist or isn't the caller's. */
export async function updatePlaybook(
  db: Db,
  userId: string,
  playbookId: string,
  input: PlaybookInput,
): Promise<boolean> {
  if (!isUuid(playbookId)) return false;
  const rows = await db
    .update(playbooks)
    .set(input)
    .where(ownedBy(userId, playbookId))
    .returning({ id: playbooks.id });
  return rows.length === 1;
}

export type DeletePlaybookResult = 'deleted' | 'not_found' | 'in_use';

/** 'in_use' when a call still references the playbook (the DB refuses the delete). */
export async function deletePlaybook(
  db: Db,
  userId: string,
  playbookId: string,
): Promise<DeletePlaybookResult> {
  if (!isUuid(playbookId)) return 'not_found';
  try {
    const rows = await db
      .delete(playbooks)
      .where(ownedBy(userId, playbookId))
      .returning({ id: playbooks.id });
    return rows.length === 1 ? 'deleted' : 'not_found';
  } catch (err) {
    if (getPgError(err)?.code === PG_ERROR.foreignKeyViolation) return 'in_use';
    throw err;
  }
}
