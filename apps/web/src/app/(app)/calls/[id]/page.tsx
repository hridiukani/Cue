import { getRecording } from '@cue/db';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, TimingBadge } from '@/components/badges';
import { publicConfig } from '@/config';
import { formatDuration } from '@/lib/call-filters';
import { getDb } from '@/server/db';
import { requireUser } from '@/server/session';
import { ReplayPlayer } from './replay-player';

export const metadata: Metadata = { title: 'Replay · Cue' };

export default async function ReplayPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();
  const { id } = await params;
  // Recordings are a shared library (not user-owned); the replay session the
  // player creates is owned by this user.
  const recording = await getRecording(getDb(), id);
  if (!recording) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link href="/calls" className="text-sm text-neutral-500 hover:text-neutral-900">
          ← Call library
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{recording.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-neutral-600">{recording.dataset.name}</span>
          <TimingBadge timing={recording.timing} />
          {recording.hasAudio && <Badge tone="blue">Audio available</Badge>}
          <span className="tabular-nums text-neutral-500">
            {formatDuration(recording.durationMs)}
          </span>
        </div>
        {recording.dataset.license === 'unspecified' && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            This dataset has no stated license. Use it internally only; don&apos;t share or publish
            its transcripts.
          </p>
        )}
      </div>

      <ReplayPlayer
        recordingId={recording.id}
        durationMs={recording.durationMs}
        wsUrl={`${publicConfig.realtimeUrl.replace(/\/$/, '')}/ws`}
      />
    </div>
  );
}
