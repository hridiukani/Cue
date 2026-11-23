import {
  type LatencyStage,
  type LatencySummary,
  type StageStats,
  summarizeLatency,
  summarizeLatencyByPromptVersion,
} from '@cue/shared';
import { LATENCY_MAX_ROWS, listSuggestionTimings } from '@cue/db';
import type { Metadata } from 'next';
import Link from 'next/link';
import { getDb } from '@/server/db';
import { requireUser } from '@/server/session';

export const metadata: Metadata = { title: 'Latency · Cue' };

/** What each stage covers, in the order a suggestion goes through them. */
const STAGES: { stage: LatencyStage; label: string; covers: string }[] = [
  {
    stage: 'pipeline',
    label: 'Cue pipeline',
    covers: 'utterance_end → request_sent: save the line, build the prompt',
  },
  {
    stage: 'firstToken',
    label: 'Time to first token',
    covers: 'request_sent → first_token: network + model (hidden reasoning included)',
  },
  { stage: 'stream', label: 'Rest of the line', covers: 'first_token → last_token' },
  {
    stage: 'paint',
    label: 'Delivery + paint',
    covers: 'last_token → rendered_in_client: to the browser and on screen',
  },
  {
    stage: 'toFirstToken',
    label: 'Line ended → first token',
    covers: 'utterance_end → first_token: what "under a second" is about',
  },
  {
    stage: 'endToEnd',
    label: 'End to end',
    covers: 'utterance_end → rendered_in_client',
  },
];

const ms = (s: StageStats | null, k: 'p50' | 'p95' | 'max') =>
  s ? `${String(Math.round(s[k]))} ms` : '–';

/**
 * p50/p95 of every stage of the suggestion path over the signed-in user's
 * own suggestions (the README's latency budget comes from here). Seeded demo
 * rows are left out by the query; replay has no speech-to-text, so none of
 * this includes STT endpointing (docs/latency.md).
 */
export default async function LatencyPage() {
  const user = await requireUser();
  const rows = await listSuggestionTimings(getDb(), user.id);
  const overall = summarizeLatency(rows);
  const byVersion = summarizeLatencyByPromptVersion(rows);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Latency</h1>
        <p className="mt-1 text-sm text-neutral-600">
          Your own suggestions, newest {LATENCY_MAX_ROWS.toLocaleString('en-US')} at most. Seeded
          demo data is never included. Replays have no speech-to-text, so these numbers{' '}
          <strong>exclude STT endpointing</strong>.
        </p>
      </div>

      <SampleCounts s={overall} />

      {overall.samples === 0 ? (
        <div className="rounded-xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-600">
          No measured suggestions yet. Open a call from the{' '}
          <Link href="/calls" className="underline">
            call library
          </Link>
          , pick a playbook, and replay it at 1× with suggestions on.
        </div>
      ) : (
        <>
          <section>
            <h2 className="text-lg font-semibold">Stages</h2>
            <div className="mt-3 overflow-x-auto rounded-xl border border-neutral-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 text-left text-xs text-neutral-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Stage</th>
                    <th className="px-4 py-2 text-right font-medium">p50</th>
                    <th className="px-4 py-2 text-right font-medium">p95</th>
                    <th className="px-4 py-2 text-right font-medium">max</th>
                    <th className="px-4 py-2 text-right font-medium">n</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {STAGES.map(({ stage, label, covers }) => {
                    const s = overall.stages[stage];
                    return (
                      <tr key={stage}>
                        <td className="px-4 py-2">
                          <div className="font-medium">{label}</div>
                          <div className="text-xs text-neutral-500">{covers}</div>
                        </td>
                        <td className="px-4 py-2 text-right tabular-nums">{ms(s, 'p50')}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{ms(s, 'p95')}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{ms(s, 'max')}</td>
                        <td className="px-4 py-2 text-right tabular-nums">{s?.count ?? 0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section>
            <h2 className="text-lg font-semibold">By prompt version</h2>
            <div className="mt-3 overflow-x-auto rounded-xl border border-neutral-200 bg-white">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 text-left text-xs text-neutral-500">
                  <tr>
                    <th className="px-4 py-2 font-medium">Prompt</th>
                    <th className="px-4 py-2 text-right font-medium">Samples</th>
                    <th className="px-4 py-2 text-right font-medium">First token p50 / p95</th>
                    <th className="px-4 py-2 text-right font-medium">End to end p50 / p95</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {byVersion.map(({ promptVersion, summary }) => (
                    <tr key={promptVersion}>
                      <td className="px-4 py-2 font-mono text-xs">{promptVersion}</td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {summary.samples} of {summary.suggestions}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {ms(summary.stages.firstToken, 'p50')} /{' '}
                        {ms(summary.stages.firstToken, 'p95')}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums">
                        {ms(summary.stages.endToEnd, 'p50')} / {ms(summary.stages.endToEnd, 'p95')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function SampleCounts({ s }: { s: LatencySummary }) {
  const failed = Object.entries(s.failed).sort(([, a], [, b]) => b - a);
  const failedTotal = failed.reduce((n, [, c]) => n + c, 0);
  const skipped = Object.entries(s.skipped).sort(([, a], [, b]) => b - a);
  const skippedTotal = skipped.reduce((n, [, c]) => n + c, 0);
  return (
    <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
      <Count label="Samples" value={s.samples} hint={`of ${String(s.suggestions)} suggestions`} />
      <Count
        label="Dropped or cancelled"
        value={failedTotal}
        hint={failed.map(([reason, n]) => `${reason} ×${String(n)}`).join(', ') || 'none'}
      />
      <Count label="Incomplete" value={s.incomplete} hint="streaming, or never painted" />
      <Count
        label="Skipped (not requested)"
        value={skippedTotal}
        hint={skipped.map(([reason, n]) => `${reason} ×${String(n)}`).join(', ') || 'none'}
      />
      <Count
        label="Out of order"
        value={s.outOfOrder}
        hint={s.outOfOrder > 0 ? 'clock or instrumentation bug' : 'none'}
        alert={s.outOfOrder > 0}
      />
    </dl>
  );
}

function Count(props: { label: string; value: number; hint: string; alert?: boolean }) {
  return (
    <div
      className={`rounded-xl border bg-white p-4 ${props.alert ? 'border-red-300' : 'border-neutral-200'}`}
    >
      <dt className="text-xs text-neutral-500">{props.label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums">{props.value}</dd>
      <dd className="mt-1 truncate text-xs text-neutral-500" title={props.hint}>
        {props.hint}
      </dd>
    </div>
  );
}
