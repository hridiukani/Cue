'use client';

import { useEffect } from 'react';
import { buttonClass } from '@/components/button-styles';

/** Shown when loading the call library throws unexpectedly (e.g. the DB is down). */
export default function CallsError({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div
      role="alert"
      className="rounded-xl border border-red-200 bg-red-50 px-6 py-10 text-center text-red-900"
    >
      <h2 className="text-base font-semibold">Something went wrong loading the call library</h2>
      <p className="mt-1 text-sm text-red-800">
        This is usually temporary (for example, the database is restarting).
      </p>
      <button type="button" onClick={retry} className={`${buttonClass('secondary')} mt-6`}>
        Try again
      </button>
    </div>
  );
}
