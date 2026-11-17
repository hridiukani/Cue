import type { ReactNode } from 'react';

export function TimingBadge({ timing }: { timing: 'real' | 'estimated' }) {
  return timing === 'real' ? (
    <Badge tone="green" title="Utterance times come from the recording">
      Real timing
    </Badge>
  ) : (
    <Badge tone="amber" title="The dataset has no timestamps; timing is estimated from text length">
      Estimated timing
    </Badge>
  );
}

export function Badge({
  tone,
  title,
  children,
}: {
  tone: 'green' | 'amber' | 'blue';
  title?: string;
  children: ReactNode;
}) {
  const tones = {
    green: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
    amber: 'bg-amber-50 text-amber-800 ring-amber-200',
    blue: 'bg-sky-50 text-sky-800 ring-sky-200',
  };
  return (
    <span
      title={title}
      className={`rounded-full px-2 py-0.5 font-medium ring-1 ring-inset ${tones[tone]}`}
    >
      {children}
    </span>
  );
}
