'use client';

import { useEffect } from 'react';
import { buttonClass } from '@/components/button-styles';

/** Shown when loading or saving playbooks throws unexpectedly (e.g. the DB is down). */
export default function PlaybooksError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      role="alert"
      className="rounded-sm border border-destructive/40 bg-card px-6 py-10 text-center text-destructive"
    >
      <h2 className="text-base font-semibold">Something went wrong loading your playbooks</h2>
      <p className="mt-1 text-sm text-foreground">
        This is usually temporary. Your playbooks are safe.
      </p>
      <button type="button" onClick={retry} className={`${buttonClass('secondary')} mt-6`}>
        Try again
      </button>
    </div>
  );
}
