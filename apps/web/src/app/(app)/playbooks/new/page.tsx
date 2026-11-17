import type { Metadata } from 'next';
import Link from 'next/link';
import { requireUser } from '@/server/session';
import { createPlaybookAction } from '../actions';
import { PlaybookForm } from '../playbook-form';

export const metadata: Metadata = { title: 'New playbook · Cue' };

export default async function NewPlaybookPage() {
  await requireUser();
  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link href="/playbooks" className="text-sm text-neutral-500 hover:text-neutral-900">
          ← Playbooks
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">New playbook</h1>
      </div>
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
  );
}
