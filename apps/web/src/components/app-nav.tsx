'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { isNavActive, NAV_LINKS } from '@/lib/nav';

/** Top navigation; the current section gets an orange underline on the header's edge. */
export function AppNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex self-stretch">
      {NAV_LINKS.map(({ href, label }) => {
        const active = isNavActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={`-mb-px flex items-center border-b-2 px-0 text-base transition-colors [&:not(:first-child)]:ml-9 ${
              active
                ? 'border-signal text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
