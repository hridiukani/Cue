import type { Metadata } from 'next';
import { BackLink, PageHeader } from '@/components/ui';
import { requireUser } from '@/server/session';
import { createPlaybookAction } from '../actions';
import { PlaybookForm } from '../playbook-form';

export const metadata: Metadata = { title: 'New playbook · Cue' };

export default async function NewPlaybookPage() {
  await requireUser();
  return (
    <div className="mx-auto max-w-3xl">
      <BackLink href="/playbooks">Playbooks</BackLink>
      <div className="mt-6">
        <PageHeader
          title="New playbook"
          subtitle="What you sell, who it's for, and the pushback you expect."
        />
      </div>
      <div className="mt-10">
        <PlaybookForm
          action={createPlaybookAction}
          initial={{
            name: '',
            productDescription: '',
            idealCustomer: '',
            toneNotes: '',
            objections: [{ objection: '', good_response: '' }],
          }}
          submitLabel="Create playbook"
          pendingLabel="Creating…"
        />
      </div>
    </div>
  );
}
