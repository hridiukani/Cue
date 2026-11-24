import { listPlaybooks } from '@cue/db';
import type { Metadata } from 'next';
import Link from 'next/link';
import { buttonClass } from '@/components/button-styles';
import { Eyebrow, Notice, PageHeader } from '@/components/ui';
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

const STEPS = [
  'Describe your product in a few lines',
  'Add the objections you hear most',
  'Run a call and watch Cue suggest',
];

export default async function PlaybooksPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const [playbooks, params] = await Promise.all([listPlaybooks(getDb(), user.id), searchParams]);
  const notice = typeof params.notice === 'string' ? NOTICES[params.notice] : undefined;

  return (
    <div>
      <PageHeader
        title="Playbooks"
        subtitle="What you sell, who you sell to, and how to answer pushback."
        actions={
          playbooks.length > 0 && (
            <Link href="/playbooks/new" className={buttonClass('primary')}>
              New playbook →
            </Link>
          )
        }
      />

      {notice && (
        <div className="mt-8">
          <Notice tone="status">{notice}</Notice>
        </div>
      )}

      {playbooks.length === 0 ? (
        <EmptyState />
      ) : (
        <ol className="mt-8 border-t border-rule">
          {playbooks.map((p, i) => (
            <li key={p.id} className="border-b border-border">
              <Link
                href={`/playbooks/${p.id}`}
                className="group flex items-baseline gap-8 py-6 focus-visible:outline-none"
              >
                <span className="w-10 shrink-0 font-mono text-sm text-muted-foreground tabular">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-lg font-medium group-hover:text-signal group-focus-visible:text-signal">
                    {p.name}
                  </span>
                  <span className="mt-1 block truncate text-sm text-muted-foreground">
                    {p.idealCustomer}
                  </span>
                </span>
                <span className="shrink-0 text-right font-mono text-sm text-muted-foreground">
                  <span className="block tabular">
                    {p.objectionCount} {p.objectionCount === 1 ? 'objection' : 'objections'}
                  </span>
                  <span className="mt-1 block">updated {dateFormat.format(p.updatedAt)}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function EmptyState() {
  return (
    <section className="mt-16">
      <div className="flex flex-col gap-8 sm:flex-row sm:items-end sm:justify-between">
        <div className="max-w-2xl">
          <Eyebrow>Nothing here yet</Eyebrow>
          <p className="mt-5 text-2xl leading-relaxed">
            A playbook tells Cue what you sell and how you handle objections, so its suggestions
            sound like you, not a script.
          </p>
        </div>
        <Link href="/playbooks/new" className={`${buttonClass('primary')} shrink-0`}>
          New playbook →
        </Link>
      </div>
      <ol className="mt-20 grid gap-8 border-t border-border pt-10 sm:grid-cols-3">
        {STEPS.map((step, i) => (
          <li key={step}>
            <span className="font-mono text-sm text-signal">{String(i + 1).padStart(2, '0')}</span>
            <p className="mt-4 text-lg text-muted-foreground">{step}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
