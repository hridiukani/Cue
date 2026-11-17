import type { PlaybookInput } from '@cue/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPlaybook,
  deletePlaybook,
  getPlaybook,
  listPlaybooks,
  updatePlaybook,
} from '../src/repositories/playbooks';
import { connectTestDb, makeCall, makeUser } from './helpers';

const { db, close } = connectTestDb();
afterAll(close);

const input = (name: string): PlaybookInput => ({
  name,
  productDescription: 'Invoice matching',
  idealCustomer: 'Finance teams',
  objections: [{ objection: 'Too expensive', good_response: 'Compare to current cost' }],
  toneNotes: null,
});

describe('playbook ownership', () => {
  let alice: string;
  let bob: string;
  let alicePlaybook: string;

  beforeEach(async () => {
    alice = (await makeUser(db)).id;
    bob = (await makeUser(db)).id;
    alicePlaybook = await createPlaybook(db, alice, input("Alice's playbook"));
  });

  it("does not list another user's playbooks", async () => {
    expect((await listPlaybooks(db, alice)).map((p) => p.id)).toEqual([alicePlaybook]);
    expect(await listPlaybooks(db, bob)).toEqual([]);
  });

  it("cannot read another user's playbook", async () => {
    expect(await getPlaybook(db, bob, alicePlaybook)).toBeNull();
    expect(await getPlaybook(db, alice, alicePlaybook)).toMatchObject({ name: "Alice's playbook" });
  });

  it("cannot edit another user's playbook, and the row is left unchanged", async () => {
    expect(await updatePlaybook(db, bob, alicePlaybook, input('Hijacked'))).toBe(false);
    expect(await getPlaybook(db, alice, alicePlaybook)).toMatchObject({
      name: "Alice's playbook",
      userId: alice,
    });
  });

  it("cannot delete another user's playbook", async () => {
    expect(await deletePlaybook(db, bob, alicePlaybook)).toBe('not_found');
    expect(await getPlaybook(db, alice, alicePlaybook)).not.toBeNull();
  });

  it('lets the owner edit and delete', async () => {
    expect(await updatePlaybook(db, alice, alicePlaybook, input('Renamed'))).toBe(true);
    expect(await getPlaybook(db, alice, alicePlaybook)).toMatchObject({ name: 'Renamed' });
    expect(await deletePlaybook(db, alice, alicePlaybook)).toBe('deleted');
    expect(await getPlaybook(db, alice, alicePlaybook)).toBeNull();
  });
});

describe('playbook repository edge cases', () => {
  it('treats a malformed id as not found instead of throwing', async () => {
    const user = (await makeUser(db)).id;
    expect(await getPlaybook(db, user, 'not-a-uuid')).toBeNull();
    expect(await updatePlaybook(db, user, 'not-a-uuid', input('x'))).toBe(false);
    expect(await deletePlaybook(db, user, 'not-a-uuid')).toBe('not_found');
  });

  it("reports 'in_use' when a call still uses the playbook", async () => {
    const user = (await makeUser(db)).id;
    const playbookId = await createPlaybook(db, user, input('Used'));
    await makeCall(db, user, playbookId);
    expect(await deletePlaybook(db, user, playbookId)).toBe('in_use');
    expect(await getPlaybook(db, user, playbookId)).not.toBeNull();
  });

  it('bumps updatedAt on edit and lists newest first', async () => {
    const user = (await makeUser(db)).id;
    const first = await createPlaybook(db, user, input('First'));
    await createPlaybook(db, user, input('Second'));
    const before = (await getPlaybook(db, user, first))?.updatedAt;
    await updatePlaybook(db, user, first, input('First, edited'));
    const after = (await getPlaybook(db, user, first))?.updatedAt;
    expect(after?.getTime()).toBeGreaterThan(before?.getTime() ?? Infinity);
    expect((await listPlaybooks(db, user))[0]).toMatchObject({ id: first, objectionCount: 1 });
  });
});
