import { listPlaybooks } from '@cue/db';
import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClass } from '@/components/button-styles';
import { getDb } from '@/server/db';
import { requireUser } from '@/server/session';

export const metadata: Metadata = { title: 'Playbooks · Cue' };

const NOTICES: Record<string, string> = {
  created: 'Playbook created.',
  updated: 'Playbook saved.',
  deleted: 'Playbook deleted.',
};

const dateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export default async function PlaybooksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const [playbooks, params] = await Promise.all([listPlaybooks(getDb(), user.id), searchParams]);
  const notice = typeof params.notice === 'string' ? NOTICES[params.notice] : undefined;

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Playbooks</h1>
          <p className="mt-1 text-sm text-neutral-600">
            What you sell, who you sell to, and how to answer pushback.
          </p>
        </div>
        {playbooks.length > 0 && (
          <Link href="/playbooks/new" className={buttonClass('primary')}>
            New playbook
          </Link>
        )}
      </div>

      {notice && (
        <p
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800"
        >
          {notice}
        </p>
      )}

      {playbooks.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 bg-white">
          {playbooks.map((p) => (
            <li key={p.id}>
              <Link
                href={`/playbooks/${p.id}`}
                className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-neutral-50 focus-visible:bg-neutral-50 focus-visible:outline-none"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{p.name}</p>
                  <p className="mt-0.5 truncate text-sm text-neutral-600">{p.idealCustomer}</p>
                </div>
                <div className="shrink-0 text-right text-xs text-neutral-500">
                  <p>
                    {p.objectionCount} {p.objectionCount === 1 ? 'objection' : 'objections'}
                  </p>
                  <p className="mt-0.5">Updated {dateFormat.format(p.updatedAt)}</p>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-neutral-300 bg-white px-6 py-14 text-center">
      <div
        aria-hidden="true"
        className="mx-auto flex size-12 items-center justify-center rounded-full bg-neutral-100 text-xl"
      >
        📘
      </div>
      <h2 className="mt-4 text-base font-semibold">No playbooks yet</h2>
      <p className="mx-auto mt-1 max-w-sm text-sm text-neutral-600">
        A playbook tells Cue what you sell and how to handle objections, so its suggestions sound
        like you.
      </p>
      <Link href="/playbooks/new" className={`${buttonClass('primary')} mt-6`}>
        Create your first playbook
      </Link>
    </div>
  );
}
