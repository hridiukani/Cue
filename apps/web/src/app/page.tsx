import type { Metadata } from 'next';
import Link from 'next/link';
import { auth } from '@/auth';
import { buttonClass } from '@/components/button-styles';
import { CueLogo } from '@/components/cue-logo';
import { Eyebrow, SectionHeading } from '@/components/ui';
import { DEFAULT_SIGNED_IN_PATH } from '@/lib/paths';

export const metadata: Metadata = {
  title: 'Cue · Real-time sales-call coach',
  description:
    'Cue listens to both sides of a sales call and suggests one short line for the rep to say next, in under a second.',
};

const STEPS = [
  {
    title: 'Write a playbook',
    body: 'What you sell, who you sell to, and how you answer the objections you hear most.',
  },
  {
    title: 'Run a call',
    body: 'Cue transcribes both sides live. Today it replays real recorded sales calls as if they were happening now.',
  },
  {
    title: 'Get one line, fast',
    body: 'The moment the prospect stops talking, one short suggestion streams in. Say it, adapt it, or ignore it.',
  },
];

/** Measured on the deployed app, 2026-11-24 (README "Latency budget", docs/latency.md). */
const NUMBERS = [
  { value: '325', unit: 'ms', label: 'Line ended → first word, p50' },
  { value: '671', unit: 'ms', label: 'Line ended → first word, p95' },
  { value: '909', unit: 'ms', label: 'End to end on screen, p95' },
  { value: '185', unit: '', label: 'Suggestions measured' },
];

const PRINCIPLES = [
  {
    title: 'Late is worse than none',
    body: 'No first word within 1.5 seconds and the suggestion is dropped, never retried. A line that arrives after the moment only distracts.',
  },
  {
    title: 'Backchannels don’t interrupt',
    body: '“Mm-hmm” from either side doesn’t trigger or cancel anything. Three short replies in a row do: that’s a prospect drifting away.',
  },
  {
    title: 'Measured, not guessed',
    body: 'Every suggestion records five timestamps, from the prospect going quiet to the line being painted. Quality is graded offline by a separate model.',
  },
];

/** Whether a session cookie exists. Reads the cookie only (no database), so this page loads even when the database is asleep. */
async function hasSession(): Promise<boolean> {
  try {
    return Boolean((await auth())?.user.id);
  } catch {
    return false;
  }
}

/** The public landing page. Shows nothing from the app's data: anyone can see it. */
export default async function LandingPage() {
  const signedIn = await hasSession();
  const cta = signedIn
    ? { href: DEFAULT_SIGNED_IN_PATH, label: 'Open Cue →' }
    : { href: '/signin', label: 'Sign in with GitHub →' };

  return (
    <div className="mx-auto max-w-6xl px-6">
      <header className="flex h-16 items-stretch justify-between border-b border-border">
        <CueLogo />
        <nav className="flex items-center gap-8 text-base">
          <a href="#how" className="hidden text-muted-foreground hover:text-foreground sm:inline">
            How it works
          </a>
          <a
            href="#numbers"
            className="hidden text-muted-foreground hover:text-foreground sm:inline"
          >
            Numbers
          </a>
          <Link href={cta.href} className="hover:text-signal">
            {signedIn ? 'Open Cue' : 'Sign in'}
          </Link>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="grid gap-12 border-b border-rule py-20 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-end">
          <div>
            <Eyebrow>Real-time sales-call coach</Eyebrow>
            <h1 className="mt-6 font-serif text-5xl leading-[1.05] tracking-tight sm:text-7xl">
              The next line, before the silence gets awkward.
            </h1>
            <p className="mt-8 max-w-2xl text-lg leading-relaxed text-muted-foreground">
              Cue listens to both sides of a sales call. The moment the prospect stops talking, it
              suggests one short line for the rep to say next, on screen in under a second.
            </p>
            <div className="mt-10 flex flex-wrap items-center gap-6">
              <Link href={cta.href} className={buttonClass('primary')}>
                {cta.label}
              </Link>
              <a href="#numbers" className="text-[15px] hover:text-signal">
                See how fast it is
              </a>
            </div>
          </div>
          <ExampleCard />
        </section>

        {/* How it works */}
        <section id="how" className="scroll-mt-8 border-b border-border py-20">
          <SectionHeading>How it works</SectionHeading>
          <ol className="mt-10 grid gap-10 sm:grid-cols-3">
            {STEPS.map((s, i) => (
              <li key={s.title}>
                <span className="font-mono text-sm text-signal">
                  {String(i + 1).padStart(2, '0')}
                </span>
                <h3 className="mt-4 text-xl font-medium">{s.title}</h3>
                <p className="mt-3 leading-relaxed text-muted-foreground">{s.body}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* Measured numbers */}
        <section id="numbers" className="scroll-mt-8 border-b border-border py-20">
          <SectionHeading>Fast enough to use mid-sentence</SectionHeading>
          <dl className="mt-10 grid grid-cols-2 gap-y-10 sm:grid-cols-4">
            {NUMBERS.map((n) => (
              <div
                key={n.label}
                className="border-border px-6 first:pl-0 sm:[&:not(:first-child)]:border-l"
              >
                <dd className="font-mono text-5xl tabular">
                  {n.value}
                  {n.unit && <span className="ml-1 text-2xl text-muted-foreground">{n.unit}</span>}
                </dd>
                <dt className="mt-3 text-sm text-muted-foreground">{n.label}</dt>
              </div>
            ))}
          </dl>
          <p className="mt-10 max-w-3xl text-sm text-muted-foreground">
            Measured on 24 November 2026 on the deployed app (Vercel, Render and Supabase, with
            Groq&apos;s gpt-oss-20b), over 185 suggestions from replayed calls. Replays don&apos;t
            run speech-to-text, so these numbers don&apos;t include it.
          </p>
        </section>

        {/* Principles */}
        <section className="py-20">
          <ul className="grid gap-10 sm:grid-cols-3">
            {PRINCIPLES.map((p) => (
              <li key={p.title} className="border-t-2 border-rule pt-6">
                <h3 className="font-serif text-2xl tracking-tight">{p.title}</h3>
                <p className="mt-3 leading-relaxed text-muted-foreground">{p.body}</p>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-border py-8 text-sm text-muted-foreground">
        <CueLogo />
        <span>Built with Next.js, Fastify, Postgres and Groq.</span>
      </footer>
    </div>
  );
}

/** What a rep sees: an illustrative exchange (made up, not from any dataset). */
function ExampleCard() {
  return (
    <figure aria-label="Example suggestion" className="border-t-2 border-signal bg-card p-6">
      <Eyebrow>Prospect</Eyebrow>
      <p className="mt-2 text-lg leading-relaxed">
        “Honestly, it’s more than we budgeted for this year.”
      </p>
      <Eyebrow className="mt-8">Suggested next line</Eyebrow>
      <p className="mt-2 font-serif text-2xl leading-snug">
        That’s fair. What would it need to save you each month to be worth it?
      </p>
      <figcaption className="mt-6 flex items-center justify-between border-t border-border pt-4 font-mono text-xs text-muted-foreground">
        <span>example</span>
        <span>
          first word in <span className="text-foreground">325 ms</span>
        </span>
      </figcaption>
    </figure>
  );
}
