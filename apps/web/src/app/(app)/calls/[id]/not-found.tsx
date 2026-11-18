import Link from 'next/link';
import { buttonClass } from '@/components/button-styles';

/** Shown for a recording that does not exist (or was removed by a re-import). */
export default function RecordingNotFound() {
  return (
    <div className="mx-auto max-w-md rounded-xl border border-neutral-200 bg-white px-6 py-12 text-center">
      <h1 className="text-lg font-semibold">Call not found</h1>
      <p className="mt-1 text-sm text-neutral-600">
        It may have been deleted, or the link is wrong.
      </p>
      <Link href="/calls" className={`${buttonClass('secondary')} mt-6`}>
        Back to the call library
      </Link>
    </div>
  );
}
