import type { ReactNode } from 'react';
import { signOut } from '@/auth';
import { AppNav } from '@/components/app-nav';
import { CueLogo } from '@/components/cue-logo';
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
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 max-w-6xl items-stretch justify-between gap-6 px-6">
          <div className="flex items-stretch gap-14">
            <CueLogo />
            <AppNav />
          </div>
          <div className="flex min-w-0 items-center gap-6 text-base">
            <span className="hidden truncate text-muted-foreground sm:inline">
              {user.name ?? user.email}
            </span>
            <form action={signOutAction}>
              <SubmitButton variant="link" pendingLabel="Signing out…">
                Sign out
              </SubmitButton>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 pb-24 pt-16">{children}</main>
    </div>
  );
}
