/** Skeleton shown while the playbook list loads. */
export default function Loading() {
  return (
    <div className="space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading playbooks…</span>
      <div className="space-y-2">
        <div className="h-7 w-40 animate-pulse rounded bg-neutral-200" />
        <div className="h-4 w-72 animate-pulse rounded bg-neutral-100" />
      </div>
      <div className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center justify-between px-5 py-4">
            <div className="space-y-2">
              <div className="h-4 w-48 animate-pulse rounded bg-neutral-200" />
              <div className="h-3 w-64 animate-pulse rounded bg-neutral-100" />
            </div>
            <div className="h-3 w-20 animate-pulse rounded bg-neutral-100" />
          </div>
        ))}
      </div>
    </div>
  );
}
