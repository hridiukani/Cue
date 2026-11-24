import { listDatasets, listRecordings } from '@cue/db';
import type { Metadata } from 'next';
import Link from 'next/link';
import { Badge, TimingBadge } from '@/components/badges';
import { buttonClass } from '@/components/button-styles';
import { FilterSelect } from '@/components/filter-select';
import { Eyebrow, PageHeader } from '@/components/ui';
import {
  DURATION_BUCKETS,
  filtersToQuery,
  formatDuration,
  PAGE_SIZE,
  parseCallFilters,
  rowNumber,
  SOURCE_TYPES,
  splitTitle,
  toRecordingQuery,
} from '@/lib/call-filters';
import { getDb } from '@/server/db';
import { requireUser } from '@/server/session';

export const metadata: Metadata = { title: 'Calls · Cue' };

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
    <div>
      <PageHeader
        title="Calls"
        subtitle="Recorded and simulated sales calls you can replay through Cue as if they were live."
      />

      {datasets.length === 0 ? (
        <NoDataYet />
      ) : (
        <>
          {/* A plain GET form: filters live in the URL; each select submits it on change. */}
          <form
            method="get"
            className="mt-10 flex flex-wrap items-baseline gap-x-10 gap-y-4 border-b border-rule pb-6 text-[15px]"
          >
            <FilterSelect
              label="Dataset"
              name="dataset"
              defaultValue={filters.dataset ?? ''}
              allLabel="All datasets"
              options={datasets.map((d) => ({ value: d.id, label: d.name }))}
            />
            <FilterSelect
              label="Duration"
              name="duration"
              defaultValue={filters.duration ?? ''}
              allLabel="Any length"
              options={Object.entries(DURATION_BUCKETS).map(([value, b]) => ({
                value,
                label: b.label,
              }))}
            />
            <FilterSelect
              label="Source"
              name="source"
              defaultValue={filters.source ?? ''}
              allLabel="Any source"
              options={Object.entries(SOURCE_TYPES).map(([value, label]) => ({ value, label }))}
            />
            <noscript>
              <button type="submit" className={buttonClass('link')}>
                Apply
              </button>
            </noscript>
            <span className="ml-auto flex items-baseline gap-6">
              {filtered && (
                <Link href="/calls" className="text-sm text-muted-foreground hover:text-signal">
                  Clear filters
                </Link>
              )}
              <span className="font-mono text-sm text-muted-foreground tabular">
                {total} {total === 1 ? 'call' : 'calls'}
              </span>
            </span>
          </form>

          {items.length === 0 ? (
            <div className="py-16">
              <Eyebrow>No matches</Eyebrow>
              <p className="mt-4 text-xl">No calls match these filters.</p>
              <Link href="/calls" className={`${buttonClass('secondary')} mt-6`}>
                Clear filters
              </Link>
            </div>
          ) : (
            <>
              <ol>
                {items.map((r, i) => {
                  const { lead, rest } = splitTitle(r.title);
                  return (
                    <li key={r.id} className="border-b border-border">
                      <Link
                        href={`/calls/${r.id}`}
                        className="group flex items-baseline gap-8 py-6 focus-visible:outline-none"
                      >
                        <span className="w-12 shrink-0 font-mono text-sm text-muted-foreground tabular">
                          {rowNumber(filters.page, i)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-lg">
                            <span className="font-medium group-hover:text-signal group-focus-visible:text-signal">
                              {lead}
                            </span>
                            {rest && <span className="text-muted-foreground"> — {rest}</span>}
                          </span>
                          <span className="mt-1 flex items-center gap-3 text-sm text-muted-foreground">
                            <span className="truncate">{r.datasetName}</span>
                            {r.hasAudio && <Badge tone="ink">Audio</Badge>}
                          </span>
                        </span>
                        <span className="hidden shrink-0 sm:inline">
                          <TimingBadge timing={r.timing} />
                        </span>
                        <span className="w-16 shrink-0 text-right font-mono text-lg tabular group-hover:text-signal">
                          {formatDuration(r.durationMs)}
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ol>

              {pages > 1 && (
                <nav
                  className="mt-10 flex items-center justify-between text-[15px]"
                  aria-label="Pagination"
                >
                  {filters.page > 1 ? (
                    <Link
                      href={`/calls${filtersToQuery(filters, { page: filters.page - 1 })}`}
                      className="hover:text-signal"
                    >
                      ← Previous
                    </Link>
                  ) : (
                    <span />
                  )}
                  <span className="font-mono text-sm text-muted-foreground tabular">
                    Page {filters.page} of {pages}
                  </span>
                  {filters.page < pages ? (
                    <Link
                      href={`/calls${filtersToQuery(filters, { page: filters.page + 1 })}`}
                      className="hover:text-signal"
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
    <section className="mt-16 max-w-2xl">
      <Eyebrow>No calls imported yet</Eyebrow>
      <p className="mt-5 text-2xl leading-relaxed">
        Import recordings from the public datasets, then refresh this page.
      </p>
      <p className="mt-6 text-muted-foreground">In a terminal at the repo root:</p>
      <pre className="mt-3 overflow-x-auto rounded-sm bg-primary px-5 py-4 font-mono text-sm text-primary-foreground">
        <code>pnpm ingest -- --dataset licensed</code>
      </pre>
      <p className="mt-4 text-sm text-muted-foreground">
        See docs/datasets.md for all datasets and options.
      </p>
    </section>
  );
}
