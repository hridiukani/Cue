import { listDatasets, listRecordings } from '@cue/db';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, TimingBadge } from '@/components/badges';
import { buttonClass } from '@/components/button-styles';
import {
  DURATION_BUCKETS,
  filtersToQuery,
  formatDuration,
  PAGE_SIZE,
  parseCallFilters,
  SOURCE_TYPES,
  toRecordingQuery,
} from '@/lib/call-filters';
import { getDb } from '@/server/db';
import { requireUser } from '@/server/session';

export const metadata: Metadata = { title: 'Call library · Cue' };

const selectClass =
  'block w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-200';

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireUser();
  const filters = parseCallFilters(await searchParams);
  const db = getDb();
  const [datasets, { items, total }] = await Promise.all([
    listDatasets(db),
    listRecordings(db, toRecordingQuery(filters)),
  ]);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const filtered = Boolean(filters.dataset ?? filters.duration ?? filters.source);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Call library</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Recorded and simulated sales calls you can replay through Cue as if they were live.
        </p>
      </div>

      {datasets.length === 0 ? (
        <NoDataYet />
      ) : (
        <>
          {/* A plain GET form: filters live in the URL and work without JavaScript. */}
          <form
            method="get"
            className="grid gap-3 rounded-xl border border-neutral-200 bg-white p-4 sm:grid-cols-4 sm:items-end"
          >
            <label className="space-y-1.5 text-sm font-medium">
              <span>Dataset</span>
              <select name="dataset" defaultValue={filters.dataset ?? ''} className={selectClass}>
                <option value="">All datasets</option>
                {datasets.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              <span>Duration</span>
              <select name="duration" defaultValue={filters.duration ?? ''} className={selectClass}>
                <option value="">Any length</option>
                {Object.entries(DURATION_BUCKETS).map(([key, b]) => (
                  <option key={key} value={key}>
                    {b.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-1.5 text-sm font-medium">
              <span>Source type</span>
              <select name="source" defaultValue={filters.source ?? ''} className={selectClass}>
                <option value="">Any source</option>
                {Object.entries(SOURCE_TYPES).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex gap-2">
              <button type="submit" className={`${buttonClass('primary')} flex-1`}>
                Apply
              </button>
              {filtered && (
                <Link href="/calls" className={buttonClass('ghost')}>
                  Clear
                </Link>
              )}
            </div>
          </form>

          {items.length === 0 ? (
            <div className="rounded-xl border border-dashed border-neutral-300 bg-white px-6 py-12 text-center">
              <h2 className="text-base font-semibold">No calls match these filters</h2>
              <Link href="/calls" className={`${buttonClass('secondary')} mt-4`}>
                Clear filters
              </Link>
            </div>
          ) : (
            <>
              <p className="text-sm text-neutral-500">
                {total} {total === 1 ? 'call' : 'calls'}
              </p>
              <ul className="divide-y divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 bg-white">
                {items.map((r) => (
                  <li key={r.id}>
                    <Link
                      href={`/calls/${r.id}`}
                      className="flex items-center justify-between gap-4 px-5 py-4 hover:bg-neutral-50 focus-visible:bg-neutral-50 focus-visible:outline-none"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-medium">{r.title}</p>
                        <p className="mt-0.5 truncate text-sm text-neutral-600">{r.datasetName}</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2 text-xs">
                        {r.hasAudio && <Badge tone="blue">Audio</Badge>}
                        <TimingBadge timing={r.timing} />
                        <span className="w-14 text-right tabular-nums text-neutral-500">
                          {formatDuration(r.durationMs)}
                        </span>
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>

              {pages > 1 && (
                <nav className="flex items-center justify-between text-sm" aria-label="Pagination">
                  {filters.page > 1 ? (
                    <Link
                      href={`/calls${filtersToQuery(filters, { page: filters.page - 1 })}`}
                      className={buttonClass('secondary')}
                    >
                      ← Previous
                    </Link>
                  ) : (
                    <span />
                  )}
                  <span className="text-neutral-500">
                    Page {filters.page} of {pages}
                  </span>
                  {filters.page < pages ? (
                    <Link
                      href={`/calls${filtersToQuery(filters, { page: filters.page + 1 })}`}
                      className={buttonClass('secondary')}
                    >
                      Next →
                    </Link>
                  ) : (
                    <span />
                  )}
                </nav>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

function NoDataYet() {
  return (
    <div className="rounded-xl border border-dashed border-neutral-300 bg-white px-6 py-14 text-center">
      <div
        aria-hidden="true"
        className="mx-auto flex size-12 items-center justify-center rounded-full bg-neutral-100 text-xl"
      >
        🎧
      </div>
      <h2 className="mt-4 text-base font-semibold">No calls imported yet</h2>
      <p className="mx-auto mt-1 max-w-md text-sm text-neutral-600">
        Import recordings from the public datasets, then refresh this page. In a terminal at the
        repo root:
      </p>
      <pre className="mx-auto mt-4 max-w-md overflow-x-auto rounded-lg bg-neutral-900 px-4 py-3 text-left text-xs text-neutral-100">
        <code>pnpm ingest -- --dataset gwenshap{'\n'}pnpm ingest -- --dataset real-sales</code>
      </pre>
      <p className="mt-3 text-xs text-neutral-500">
        See docs/datasets.md for all datasets and options.
      </p>
    </div>
  );
}
