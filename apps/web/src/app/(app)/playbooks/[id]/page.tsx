import { getPlaybook } from '@cue/db';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getDb } from '@/server/db';
import { requireUser } from '@/server/session';
import { deletePlaybookAction, updatePlaybookAction } from '../actions';
import { DeletePlaybookButton } from '../delete-playbook-button';
import { PlaybookForm } from '../playbook-form';

export const metadata: Metadata = { title: 'Edit playbook · Cue' };

export default async function EditPlaybookPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  // Scoped to the signed-in user: someone else's playbook is a 404, same as a missing one.
  const playbook = await getPlaybook(getDb(), user.id, id);
  if (!playbook) notFound();

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link href="/playbooks" className="text-sm text-neutral-500 hover:text-neutral-900">
          ← Playbooks
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">Edit playbook</h1>
      </div>

      <PlaybookForm
        action={updatePlaybookAction.bind(null, playbook.id)}
        initial={{
          name: playbook.name,
          productDescription: playbook.productDescription,
          idealCustomer: playbook.idealCustomer,
          toneNotes: playbook.toneNotes ?? '',
          objections: playbook.objections,
        }}
        submitLabel="Save changes"
        pendingLabel="Saving…"
      />

      <section className="rounded-xl border border-red-200 bg-white p-5">
        <h2 className="text-sm font-semibold text-red-900">Danger zone</h2>
        <p className="mt-1 mb-4 text-sm text-neutral-600">
          Deleting removes this playbook for good. Playbooks used by recorded calls can’t be
          deleted.
        </p>
        <DeletePlaybookButton
          action={deletePlaybookAction.bind(null, playbook.id)}
          playbookName={playbook.name}
        />
      </section>
    </div>
  );
}
