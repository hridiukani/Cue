/** Skeleton shown while a call loads. */
export default function Loading() {
  return (
    <div className="mx-auto max-w-2xl space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading call…</span>
      <div className="h-7 w-48 animate-pulse rounded bg-border" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <div className="h-4 w-32 animate-pulse rounded bg-border" />
          <div className="h-20 w-full animate-pulse rounded-sm bg-secondary" />
        </div>
      ))}
    </div>
  );
}
