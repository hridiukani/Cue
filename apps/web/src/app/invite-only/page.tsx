import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { signOut } from '@/auth';
import { SubmitButton } from '@/components/submit-button';
import { DEFAULT_SIGNED_IN_PATH } from '@/lib/paths';
import { getAccess } from '@/server/session';

export const metadata: Metadata = { title: 'Invite only · Cue' };

/**
 * Where a GitHub account that isn't on ALLOWED_GITHUB_LOGINS ends up, at
 * sign-in or on any later request. Public (no sign-in needed), and shows
 * nothing from the app.
 */
export default async function InviteOnlyPage() {
  const access = await getAccess();
  if (access.kind === 'ok') redirect(DEFAULT_SIGNED_IN_PATH);

  async function signOutAction() {
    'use server';
    await signOut({ redirectTo: '/signin' });
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Cue is invite-only</h1>
        <p className="mt-3 text-sm text-neutral-600">
          This deployment is open to a short list of GitHub accounts, and yours isn&apos;t on it. If
          you think it should be, ask the person who sent you the link.
        </p>
        {access.kind === 'not_invited' ? (
          <form action={signOutAction} className="mt-6">
            <SubmitButton className="w-full" pendingLabel="Signing out…">
              Sign out and use another account
            </SubmitButton>
          </form>
        ) : (
          <Link
            href="/signin"
            className="mt-6 block text-center text-sm text-neutral-600 underline hover:text-neutral-900"
          >
            Back to sign-in
          </Link>
        )}
      </div>
    </main>
  );
}
