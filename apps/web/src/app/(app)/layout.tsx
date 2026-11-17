import Link from 'next/link';
import type { ReactNode } from 'react';
import { signOut } from '@/auth';
import { SubmitButton } from '@/components/submit-button';
import { requireUser } from '@/server/session';

/** Shell for every signed-in page. requireUser() redirects to /signin otherwise. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();

  async function signOutAction() {
    'use server';
    await signOut({ redirectTo: '/signin' });
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-neutral-200 bg-white">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-4 px-4 py-3">
          <div className="flex items-center gap-6">
            <Link href="/playbooks" className="text-lg font-semibold tracking-tight">
              Cue
            </Link>
            <nav className="flex gap-4 text-sm">
              <Link href="/playbooks" className="text-neutral-600 hover:text-neutral-900">
                Playbooks
              </Link>
              <Link href="/calls" className="text-neutral-600 hover:text-neutral-900">
                Calls
              </Link>
            </nav>
          </div>
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden truncate text-sm text-neutral-600 sm:inline">
              {user.name ?? user.email}
            </span>
            <form action={signOutAction}>
              <SubmitButton variant="ghost" pendingLabel="Signing out…" className="px-3">
                Sign out
              </SubmitButton>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
    </div>
  );
}
