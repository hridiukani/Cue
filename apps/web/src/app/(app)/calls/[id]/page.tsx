import { getRecording, getRecordingAudio, listPlaybooks } from '@cue/db';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { Badge, TimingBadge } from '@/components/badges';
import { BackLink, Notice } from '@/components/ui';
import { publicConfig } from '@/config';
import { formatDuration, splitTitle } from '@/lib/call-filters';
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
  const { lead, rest } = splitTitle(recording.title);

  return (
    <div className="space-y-8">
      <div>
        <BackLink href="/calls">Calls</BackLink>
        <h1 className="mt-6 font-serif text-4xl leading-tight tracking-tight sm:text-5xl">
          {lead}
          {rest && <span className="text-muted-foreground"> — {rest}</span>}
        </h1>
        <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="text-muted-foreground">{recording.dataset.name}</span>
          <TimingBadge timing={recording.timing} />
          {audio ? (
            <Badge tone="ink">Audio</Badge>
          ) : (
            recording.hasAudio &&
            (playAudio ? (
              <Badge
                tone="signal"
                title="Import with: pnpm ingest -- --dataset real-sales --with-audio"
              >
                Audio not downloaded
              </Badge>
            ) : (
              <Badge tone="neutral" title="This deployment hosts transcripts only">
                Audio not hosted in this deployment
              </Badge>
            ))
          )}
          <span className="font-mono tabular text-foreground">
            {formatDuration(recording.durationMs)}
          </span>
        </div>
        {recording.dataset.license === 'unspecified' && (
          <div className="mt-5">
            <Notice tone="status">
              This dataset has no stated license. Use it internally only; don&apos;t share or
              publish its transcripts.
            </Notice>
          </div>
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
