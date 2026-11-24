import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { signOut } from '@/auth';
import { CueLogo } from '@/components/cue-logo';
import { SubmitButton } from '@/components/submit-button';
import { Eyebrow } from '@/components/ui';
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
    <main className="mx-auto flex min-h-screen max-w-6xl flex-col px-6">
      <div className="flex h-16 items-stretch border-b border-border">
        <CueLogo href="/signin" />
      </div>
      <div className="flex flex-1 flex-col justify-center py-16">
        <Eyebrow>Invite only</Eyebrow>
        <h1 className="mt-5 max-w-3xl font-serif text-5xl leading-tight tracking-tight">
          Cue is invite-only
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
          This deployment is open to a short list of GitHub accounts, and yours isn&apos;t on it. If
          you think it should be, ask the person who sent you the link.
        </p>
        {access.kind === 'not_invited' ? (
          <form action={signOutAction} className="mt-10">
            <SubmitButton pendingLabel="Signing out…">
              Sign out and use another account
            </SubmitButton>
          </form>
        ) : (
          <Link href="/signin" className="mt-10 inline-block text-[15px] hover:text-signal">
            Back to sign-in
          </Link>
        )}
      </div>
    </main>
  );
}
