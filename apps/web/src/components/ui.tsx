import Link from 'next/link';
import type { ReactNode } from 'react';

/**
 * Page title block: large serif heading, a muted line under it, then a dark
 * rule. `actions` sit to the right of the heading on wide screens.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="border-b border-rule pb-8">
      <div className="flex flex-wrap items-end justify-between gap-6">
        <h1 className="font-serif text-5xl leading-none tracking-tight sm:text-6xl">{title}</h1>
        {actions && <div className="flex shrink-0 items-center gap-3">{actions}</div>}
      </div>
      {subtitle && <p className="mt-6 max-w-3xl text-lg text-muted-foreground">{subtitle}</p>}
    </header>
  );
}

/** Small mono, letter-spaced, uppercase label: "NOTHING HERE YET". */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={`font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground ${className}`}
    >
      {children}
    </p>
  );
}

/** Serif section heading ("By stage"). */
export function SectionHeading({
  children,
  id,
  className = '',
}: {
  children: ReactNode;
  id?: string;
  className?: string;
}) {
  return (
    <h2 id={id} className={`font-serif text-3xl tracking-tight ${className}`}>
      {children}
    </h2>
  );
}

/** A one-line message: `status` for confirmations, `error` for problems. */
export function Notice({ tone, children }: { tone: 'status' | 'error'; children: ReactNode }) {
  return (
    <p
      role={tone === 'error' ? 'alert' : 'status'}
      className={`border-l-2 bg-card px-4 py-3 text-sm ${
        tone === 'error' ? 'border-destructive text-destructive' : 'border-signal text-foreground'
      }`}
    >
      {children}
    </p>
  );
}

/** "← Playbooks": the way back to a list, above a page title. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-block font-mono text-xs uppercase tracking-[0.2em] text-muted-foreground hover:text-signal"
    >
      ← {children}
    </Link>
  );
}
