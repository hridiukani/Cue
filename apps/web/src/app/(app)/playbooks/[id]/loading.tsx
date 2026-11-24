/** Skeleton shown while a playbook loads for editing. */
export default function Loading() {
  return (
    <div className="mx-auto max-w-2xl space-y-6" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading playbook…</span>
      <div className="h-7 w-48 animate-pulse rounded-sm bg-border" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <div className="h-4 w-32 animate-pulse rounded-sm bg-border" />
          <div className="h-20 w-full animate-pulse rounded-sm bg-secondary" />
        </div>
      ))}
    </div>
  );
}
