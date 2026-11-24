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
import { buttonClass } from '@/components/button-styles';
import { Eyebrow, PageHeader, SectionHeading } from '@/components/ui';
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

/** "412 ms" with a muted unit, or a dash when there is no sample. */
function Ms({ s, k }: { s: StageStats | null; k: 'p50' | 'p95' | 'max' }) {
  if (!s) return <span className="text-muted-foreground">–</span>;
  return (
    <>
      {Math.round(s[k])} <span className="text-muted-foreground">ms</span>
    </>
  );
}

/** Short, readable names for the reasons the summary counts. */
const REASON_LABEL: Record<string, string> = {
  prospect_backchannel: 'backchannel',
  cancelled_newer: 'newer line',
  cancelled_rep_spoke: 'rep spoke',
  cancelled_stopped: 'stopped',
  first_token_timeout: 'first token > 1.5 s',
  timeout: 'too slow',
  rate_limited: 'rate limited',
  api_error: 'provider error',
  empty_output: 'empty',
};

function reasons(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort(([, a], [, b]) => b - a)
    .map(([r, n]) => `${REASON_LABEL[r] ?? r}${n > 1 ? ` ×${String(n)}` : ''}`)
    .join(', ');
}

const total = (counts: Record<string, number>) => Object.values(counts).reduce((a, b) => a + b, 0);

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
    <div>
      <PageHeader
        title="Latency"
        subtitle={`Your newest ${LATENCY_MAX_ROWS.toLocaleString('en-US')} suggestions. Demo data is left out, and replays skip speech-to-text, so these numbers don't include it.`}
      />

      <SampleCounts s={overall} />

      {overall.samples === 0 ? (
        <section className="mt-16 max-w-2xl">
          <Eyebrow>No samples yet</Eyebrow>
          <p className="mt-5 text-2xl leading-relaxed">
            Replay a call at 1× with suggestions on, and its timings show up here.
          </p>
          <Link href="/calls" className={`${buttonClass('primary')} mt-8`}>
            Open the call library →
          </Link>
        </section>
      ) : (
        <>
          <section className="mt-16">
            <SectionHeading>By stage</SectionHeading>
            <table className="mt-6 w-full text-[15px]">
              <thead>
                <tr className="border-b border-rule text-left text-sm text-muted-foreground">
                  <th className="pb-3 font-normal">Stage</th>
                  <th className="w-32 pb-3 text-right font-normal">p50</th>
                  <th className="w-32 pb-3 text-right font-normal">p95</th>
                  <th className="w-40 pb-3 text-right font-normal">max</th>
                </tr>
              </thead>
              <tbody>
                {STAGES.map(({ stage, label, covers }) => {
                  const s = overall.stages[stage];
                  const isTotal = stage === 'toFirstToken' || stage === 'endToEnd';
                  return (
                    <tr key={stage} className="border-b border-border">
                      <td className="py-4">
                        <div className={isTotal ? 'font-medium' : ''}>{label}</div>
                        <div className="text-sm text-muted-foreground">{covers}</div>
                      </td>
                      <td className="py-4 text-right font-mono text-lg tabular">
                        <Ms s={s} k="p50" />
                      </td>
                      <td className="py-4 text-right font-mono text-lg tabular">
                        <Ms s={s} k="p95" />
                      </td>
                      <td className="py-4 text-right font-mono text-lg tabular">
                        <Ms s={s} k="max" />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="mt-16">
            <SectionHeading>By prompt version</SectionHeading>
            <table className="mt-6 w-full text-[15px]">
              <thead>
                <tr className="border-b border-rule text-left text-sm text-muted-foreground">
                  <th className="pb-3 font-normal">Prompt</th>
                  <th className="pb-3 text-right font-normal">Samples</th>
                  <th className="pb-3 text-right font-normal">First token p50 / p95</th>
                  <th className="pb-3 text-right font-normal">End to end p50 / p95</th>
                </tr>
              </thead>
              <tbody>
                {byVersion.map(({ promptVersion, summary }) => (
                  <tr key={promptVersion} className="border-b border-border">
                    <td className="py-4 font-mono text-sm">{promptVersion}</td>
                    <td className="py-4 text-right font-mono tabular">
                      {summary.samples}{' '}
                      <span className="text-muted-foreground">of {summary.suggestions}</span>
                    </td>
                    <td className="py-4 text-right font-mono tabular">
                      <Ms s={summary.stages.firstToken} k="p50" /> /{' '}
                      <Ms s={summary.stages.firstToken} k="p95" />
                    </td>
                    <td className="py-4 text-right font-mono tabular">
                      <Ms s={summary.stages.endToEnd} k="p50" /> /{' '}
                      <Ms s={summary.stages.endToEnd} k="p95" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

function SampleCounts({ s }: { s: LatencySummary }) {
  return (
    <dl className="mt-12 grid grid-cols-2 gap-y-8 sm:grid-cols-5">
      <Count label="Samples" value={s.samples} hint={`of ${String(s.suggestions)}`} />
      <Count label="Dropped" value={total(s.failed)} hint={reasons(s.failed)} />
      <Count
        label="Incomplete"
        value={s.incomplete}
        hint={s.incomplete > 0 ? 'still streaming or not painted' : ''}
      />
      <Count label="Skipped" value={total(s.skipped)} hint={reasons(s.skipped)} />
      <Count
        label="Out of order"
        value={s.outOfOrder}
        hint={s.outOfOrder > 0 ? 'clock or instrumentation bug' : ''}
        alert={s.outOfOrder > 0}
      />
    </dl>
  );
}

function Count(props: { label: string; value: number; hint: string; alert?: boolean }) {
  return (
    <div className="border-border px-6 first:pl-0 sm:[&:not(:first-child)]:border-l">
      <dt className="text-sm text-muted-foreground">{props.label}</dt>
      <dd
        className={`mt-2 font-mono text-4xl tabular ${props.alert ? 'text-destructive' : 'text-foreground'}`}
      >
        {props.value}
      </dd>
      {props.hint && (
        <dd className="mt-1 truncate text-sm text-muted-foreground" title={props.hint}>
          {props.hint}
        </dd>
      )}
    </div>
  );
}
