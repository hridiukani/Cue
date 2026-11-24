import Link from 'next/link';

/** Orange dot + italic serif wordmark. */
export function CueLogo({ href = '/' }: { href?: string }) {
  return (
    <Link href={href} className="flex items-center gap-3" aria-label="Cue home">
      <span aria-hidden="true" className="size-2 rounded-full bg-signal" />
      <span className="font-serif text-3xl italic leading-none tracking-tight">Cue</span>
    </Link>
  );
}
