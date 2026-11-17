import Link from 'next/link';
import { buttonClass } from '@/components/button-styles';

/** Shown for a missing playbook and for one owned by someone else (deliberately identical). */
export default function PlaybookNotFound() {
  return (
    <div className="mx-auto max-w-md rounded-xl border border-neutral-200 bg-white px-6 py-12 text-center">
      <h1 className="text-lg font-semibold">Playbook not found</h1>
      <p className="mt-1 text-sm text-neutral-600">
        It may have been deleted, or the link is wrong.
      </p>
      <Link href="/playbooks" className={`${buttonClass('secondary')} mt-6`}>
        Back to playbooks
      </Link>
    </div>
  );
}
