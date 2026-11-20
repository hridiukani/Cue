import { getRecording, getRecordingAudio, listPlaybooks } from '@cue/db';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Badge, TimingBadge } from '@/components/badges';
import { publicConfig } from '@/config';
import { formatDuration } from '@/lib/call-filters';
import { audioPlaybackEnabled } from '@/server/blobs';
import { getDb } from '@/server/db';
import { requireUser } from '@/server/session';
import { ReplayPlayer } from './replay-player';

export const metadata: Metadata = { title: 'Call · Cue' };

export default async function ReplayPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  // Recordings are a shared library (not user-owned); the replay session the
  // player creates is owned by this user.
  const playAudio = audioPlaybackEnabled(); // off in deployments: no audio is hosted
  const [recording, playbooks, audio] = await Promise.all([
    getRecording(getDb(), id),
    listPlaybooks(getDb(), user.id), // only this user's playbooks
    playAudio ? getRecordingAudio(getDb(), id) : null,
  ]);
  if (!recording) notFound();

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <Link href="/calls" className="text-sm text-neutral-500 hover:text-neutral-900">
          ← Call library
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{recording.title}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-neutral-600">{recording.dataset.name}</span>
          <TimingBadge timing={recording.timing} />
          {audio ? (
            <Badge tone="blue">Audio</Badge>
          ) : (
            recording.hasAudio &&
            (playAudio ? (
              <Badge
                tone="amber"
                title="Import with: pnpm ingest -- --dataset real-sales --with-audio"
              >
                Audio not downloaded
              </Badge>
            ) : (
              <Badge tone="amber" title="This deployment hosts transcripts only">
                Audio not hosted in this deployment
              </Badge>
            ))
          )}
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
        playbooks={playbooks.map((p) => ({ id: p.id, name: p.name }))}
        wsUrl={`${publicConfig.realtimeUrl.replace(/\/$/, '')}/ws`}
        audioSrc={audio ? `/api/recordings/${recording.id}/audio` : null}
      />
    </div>
  );
}
