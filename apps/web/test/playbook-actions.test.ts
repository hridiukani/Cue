import { randomUUID } from 'node:crypto';
import { createDb, createPlaybook, type Db, getPlaybook, listPlaybooks, schema } from '@cue/db';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import type { CurrentUser } from '@/server/session';

/**
 * End-to-end ownership tests for the playbook server actions: real actions,
 * real repository, real (throwaway) Postgres. Only three things are faked:
 * which user the session says is signed in, and Next's redirect/revalidate.
 */

const h = vi.hoisted(() => ({
  db: undefined as Db | undefined,
  signedInAs: null as CurrentUser | null,
}));

class RedirectSignal extends Error {
  constructor(readonly url: string) {
    super(`redirect to ${url}`);
  }
}

vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new RedirectSignal(url);
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/db', () => ({
  getDb: () => {
    if (!h.db) throw new Error('test db not ready');
    return h.db;
  },
}));
vi.mock('@/server/session', () => ({
  // Same contract as the real requireUser(): redirect to /signin when signed out.
  requireUser: () => {
    if (!h.signedInAs) throw new RedirectSignal('/signin');
    return Promise.resolve(h.signedInAs);
  },
}));

const { createPlaybookAction, deletePlaybookAction, updatePlaybookAction } =
  await import('@/app/(app)/playbooks/actions');

let close: () => Promise<void>;
let db: Db;

beforeAll(() => {
  const conn = createDb(inject('testDatabaseUrl'));
  db = conn.db;
  close = conn.close;
  h.db = db;
});
afterAll(() => close());

async function makeUser(name: string): Promise<CurrentUser> {
  const [row] = await db
    .insert(schema.users)
    .values({ email: `${name}-${randomUUID()}@test.local`, name })
    .returning();
  if (!row) throw new Error('no user');
  return { id: row.id, email: row.email, name: row.name };
}

function playbookForm(name: string, extra: Record<string, string> = {}): FormData {
  const fd = new FormData();
  fd.set('name', name);
  fd.set('productDescription', 'Invoice matching');
  fd.set('idealCustomer', 'Finance teams');
  fd.set('toneNotes', '');
  fd.append('objection', 'Too expensive');
  fd.append('good_response', 'Compare to the cost of doing it by hand');
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return fd;
}

/** Run an action and return where it redirected, or its returned state. */
async function run<T>(fn: () => Promise<T>): Promise<{ redirect: string } | { state: T }> {
  try {
    return { state: await fn() };
  } catch (err) {
    if (err instanceof RedirectSignal) return { redirect: err.url };
    throw err;
  }
}

const IDLE = { status: 'idle' } as const;
// Same wording for "missing" and "someone else's": the response must not reveal which.
const NOT_FOUND = 'This playbook no longer exists, or you do not have access to it.';

describe('playbook actions: one user can never touch another user’s playbook', () => {
  let alice: CurrentUser;
  let bob: CurrentUser;
  let alicePlaybookId: string;

  beforeEach(async () => {
    alice = await makeUser('alice');
    bob = await makeUser('bob');
    alicePlaybookId = await createPlaybook(db, alice.id, {
      name: "Alice's playbook",
      productDescription: 'Original',
      idealCustomer: 'Original',
      objections: [],
      toneNotes: null,
    });
    h.signedInAs = bob;
  });

  it('Bob cannot edit Alice’s playbook; it is reported as not found and left unchanged', async () => {
    const result = await run(() =>
      updatePlaybookAction(alicePlaybookId, IDLE, playbookForm('Hijacked by Bob')),
    );

    expect(result).toEqual({ state: { status: 'error', message: NOT_FOUND, fieldErrors: {} } });
    expect(await getPlaybook(db, alice.id, alicePlaybookId)).toMatchObject({
      name: "Alice's playbook",
      productDescription: 'Original',
      userId: alice.id,
    });
  });

  it('Bob cannot delete Alice’s playbook', async () => {
    const result = await run(() => deletePlaybookAction(alicePlaybookId, IDLE));

    expect(result).toEqual({ state: { status: 'error', message: NOT_FOUND } });
    expect(await getPlaybook(db, alice.id, alicePlaybookId)).not.toBeNull();
  });

  it('a smuggled userId field cannot create a playbook for Alice', async () => {
    const result = await run(() =>
      createPlaybookAction(IDLE, playbookForm('Planted', { userId: alice.id })),
    );

    expect(result).toEqual({ redirect: '/playbooks?notice=created' });
    expect((await listPlaybooks(db, alice.id)).map((p) => p.name)).toEqual(["Alice's playbook"]);
    expect((await listPlaybooks(db, bob.id)).map((p) => p.name)).toEqual(['Planted']);
  });

  it('a signed-out request is redirected and writes nothing', async () => {
    h.signedInAs = null;
    expect(await run(() => createPlaybookAction(IDLE, playbookForm('Anon')))).toEqual({
      redirect: '/signin',
    });
    expect(
      await run(() => updatePlaybookAction(alicePlaybookId, IDLE, playbookForm('Anon'))),
    ).toEqual({ redirect: '/signin' });
    expect(await run(() => deletePlaybookAction(alicePlaybookId, IDLE))).toEqual({
      redirect: '/signin',
    });
    expect(await getPlaybook(db, alice.id, alicePlaybookId)).toMatchObject({
      name: "Alice's playbook",
    });
  });

  it('a malformed or non-string id is rejected without touching the database', async () => {
    for (const badId of ['not-a-uuid', 42, { id: alicePlaybookId }]) {
      expect(await run(() => updatePlaybookAction(badId, IDLE, playbookForm('x')))).toMatchObject({
        state: { status: 'error' },
      });
      expect(await run(() => deletePlaybookAction(badId, IDLE))).toMatchObject({
        state: { status: 'error' },
      });
    }
  });

  it('the owner can edit and delete their own playbook', async () => {
    h.signedInAs = alice;
    expect(
      await run(() => updatePlaybookAction(alicePlaybookId, IDLE, playbookForm('Renamed'))),
    ).toEqual({ redirect: '/playbooks?notice=updated' });
    expect(await getPlaybook(db, alice.id, alicePlaybookId)).toMatchObject({ name: 'Renamed' });

    expect(await run(() => deletePlaybookAction(alicePlaybookId, IDLE))).toEqual({
      redirect: '/playbooks?notice=deleted',
    });
    expect(await getPlaybook(db, alice.id, alicePlaybookId)).toBeNull();
  });
});

describe('playbook actions: validation', () => {
  it('returns field errors and writes nothing for an invalid form', async () => {
    const carol = await makeUser('carol');
    h.signedInAs = carol;
    const fd = playbookForm('');
    fd.set('idealCustomer', '   ');

    const result = await run(() => createPlaybookAction(IDLE, fd));

    expect(result).toEqual({
      state: {
        status: 'error',
        message: 'Please fix the highlighted fields.',
        fieldErrors: { name: 'Name is required', idealCustomer: 'Ideal customer is required' },
      },
    });
    expect(await listPlaybooks(db, carol.id)).toEqual([]);
  });
});
