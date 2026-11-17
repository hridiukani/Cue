'use server';

import { createPlaybook, deletePlaybook, updatePlaybook } from '@cue/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { type FieldErrors, parsePlaybookForm } from '@/lib/playbook-form';
import { getDb } from '@/server/db';
import { requireUser } from '@/server/session';

/**
 * Playbook server actions. Security model:
 * - Every action calls requireUser() itself; the proxy is not trusted.
 * - The owner is always the session user. Nothing from the client (form
 *   fields, bound ids) can choose whose playbook is written.
 * - Ids from the client are validated, then every query is scoped to the
 *   session user in the repository, so another user's playbook is "not found".
 */

export type PlaybookFormState =
  { status: 'idle' } | { status: 'error'; message: string; fieldErrors: FieldErrors };

export type DeleteState = { status: 'idle' } | { status: 'error'; message: string };

const NOT_FOUND = 'This playbook no longer exists, or you do not have access to it.';
const INVALID = 'Please fix the highlighted fields.';

const PlaybookId = z.uuid();

export async function createPlaybookAction(
  _prev: PlaybookFormState,
  formData: FormData,
): Promise<PlaybookFormState> {
  const user = await requireUser();
  const parsed = parsePlaybookForm(formData);
  if (!parsed.ok) return { status: 'error', message: INVALID, fieldErrors: parsed.fieldErrors };

  await createPlaybook(getDb(), user.id, parsed.input);
  revalidatePath('/playbooks');
  redirect('/playbooks?notice=created');
}

export async function updatePlaybookAction(
  playbookId: unknown,
  _prev: PlaybookFormState,
  formData: FormData,
): Promise<PlaybookFormState> {
  const user = await requireUser();
  const id = PlaybookId.safeParse(playbookId);
  if (!id.success) return { status: 'error', message: NOT_FOUND, fieldErrors: {} };

  const parsed = parsePlaybookForm(formData);
  if (!parsed.ok) return { status: 'error', message: INVALID, fieldErrors: parsed.fieldErrors };

  const updated = await updatePlaybook(getDb(), user.id, id.data, parsed.input);
  if (!updated) return { status: 'error', message: NOT_FOUND, fieldErrors: {} };

  revalidatePath('/playbooks');
  revalidatePath(`/playbooks/${id.data}`);
  redirect('/playbooks?notice=updated');
}

export async function deletePlaybookAction(
  playbookId: unknown,
  _prev: DeleteState,
): Promise<DeleteState> {
  const user = await requireUser();
  const id = PlaybookId.safeParse(playbookId);
  if (!id.success) return { status: 'error', message: NOT_FOUND };

  const result = await deletePlaybook(getDb(), user.id, id.data);
  if (result === 'not_found') return { status: 'error', message: NOT_FOUND };
  if (result === 'in_use') {
    return {
      status: 'error',
      message: 'This playbook is used by recorded calls, so it can’t be deleted.',
    };
  }

  revalidatePath('/playbooks');
  redirect('/playbooks?notice=deleted');
}
