import { getPlaybook } from '@cue/db';
import type { Metadata } from 'next';
import { BackLink, Eyebrow, PageHeader } from '@/components/ui';
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
    <div className="mx-auto max-w-3xl">
      <BackLink href="/playbooks">Playbooks</BackLink>
      <div className="mt-6">
        <PageHeader title={playbook.name} subtitle="Edit what Cue knows about this sale." />
      </div>

      <div className="mt-10">
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
      </div>

      <section className="mt-16 border-t border-border pt-8">
        <Eyebrow className="text-destructive">Danger zone</Eyebrow>
        <p className="mt-3 mb-5 text-sm text-muted-foreground">
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
