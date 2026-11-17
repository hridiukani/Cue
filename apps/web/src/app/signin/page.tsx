import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { SIGNIN_ERROR, signIn } from '@/auth';
import { safeRedirectPath } from '@/lib/paths';
import { getCurrentUser } from '@/server/session';
import { SubmitButton } from '@/components/submit-button';

export const metadata: Metadata = { title: 'Sign in · Cue' };

const ERROR_MESSAGES: Record<string, string> = {
  [SIGNIN_ERROR.noEmail]:
    'Your GitHub account has no email address we can read. Add a verified email on GitHub and try again.',
  [SIGNIN_ERROR.emailInUse]:
    'That email is already used by another Cue account, so we did not link it automatically.',
  AccessDenied: 'Sign-in was cancelled or denied.',
};
const GENERIC_ERROR = 'Sign-in failed. Please try again.';

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const redirectTo = safeRedirectPath(params.callbackUrl);

  if (await getCurrentUser()) redirect(redirectTo);

  const errorCode = typeof params.error === 'string' ? params.error : undefined;
  const error = errorCode ? (ERROR_MESSAGES[errorCode] ?? GENERIC_ERROR) : undefined;

  async function signInWithGitHub() {
    'use server';
    await signIn('github', { redirectTo });
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-neutral-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Cue</h1>
        <p className="mt-1 text-sm text-neutral-600">Real-time coaching for sales calls.</p>

        {error && (
          <p
            role="alert"
            className="mt-6 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
          >
            {error}
          </p>
        )}

        <form action={signInWithGitHub} className="mt-6">
          <SubmitButton className="w-full" pendingLabel="Redirecting to GitHub…">
            <GitHubMark />
            Continue with GitHub
          </SubmitButton>
        </form>
      </div>
    </main>
  );
}

function GitHubMark() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className="size-4 fill-current">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
