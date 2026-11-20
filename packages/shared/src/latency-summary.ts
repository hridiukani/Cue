import { SuggestionTimingsSchema } from './latency';

/**
 * p50/p95 of each stage of the suggestion path, over a user's real
 * suggestions (the /latency page and the README's latency budget).
 *
 * Stages, from the five timestamps (docs/latency.md):
 *   pipeline     utterance_end → suggestion_request_sent   (Cue: save the final, build the prompt)
 *   firstToken   suggestion_request_sent → first_token     (network + model, incl. hidden reasoning)
 *   stream       first_token → last_token                  (the rest of the line)
 *   paint        last_token → rendered_in_client           (send to the browser + paint)
 *   endToEnd     utterance_end → rendered_in_client
 *   toFirstToken utterance_end → first_token               (what "under a second" is about)
 *
 * In replay there is no speech-to-text: utterance_end is when the transcript
 * line was emitted, so none of this includes STT endpointing.
 */

export const LATENCY_STAGES = [
  'pipeline',
  'firstToken',
  'stream',
  'paint',
  'toFirstToken',
  'endToEnd',
] as const;
export type LatencyStage = (typeof LATENCY_STAGES)[number];

export interface TimingRow {
  status: 'streaming' | 'complete' | 'failed';
  failureReason: string | null;
  promptVersion: string;
  utteranceEndAt: Date | null;
  requestSentAt: Date | null;
  firstTokenAt: Date | null;
  lastTokenAt: Date | null;
  clientRenderedAt: Date | null;
}

export interface StageStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface LatencySummary {
  /** Every suggestion considered. */
  suggestions: number;
  /** Complete and painted, with all five timestamps in order: the samples. */
  samples: number;
  failed: Record<string, number>;
  /** Still streaming, or complete but never reported as painted. */
  incomplete: number;
  /** Timestamps out of order: a clock or instrumentation bug, shown, never hidden. */
  outOfOrder: number;
  stages: Record<LatencyStage, StageStats | null>;
}

/** Nearest-rank percentile of an ascending, non-empty list. */
export function nearestRank(sorted: readonly number[], p: number): number {
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  const v = sorted[rank - 1];
  if (v === undefined) throw new Error('nearestRank of an empty list');
  return v;
}

function stats(values: number[]): StageStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    max: nearestRank(sorted, 100),
  };
}

export function summarizeLatency(rows: readonly TimingRow[]): LatencySummary {
  const values: Record<LatencyStage, number[]> = {
    pipeline: [],
    firstToken: [],
    stream: [],
    paint: [],
    toFirstToken: [],
    endToEnd: [],
  };
  const failed: Record<string, number> = {};
  let samples = 0;
  let incomplete = 0;
  let outOfOrder = 0;
  for (const r of rows) {
    if (r.status === 'failed') {
      const reason = r.failureReason ?? 'unknown';
      failed[reason] = (failed[reason] ?? 0) + 1;
      continue;
    }
    const { utteranceEndAt, requestSentAt, firstTokenAt, lastTokenAt, clientRenderedAt } = r;
    if (
      r.status !== 'complete' ||
      !utteranceEndAt ||
      !requestSentAt ||
      !firstTokenAt ||
      !lastTokenAt ||
      !clientRenderedAt
    ) {
      incomplete++;
      continue;
    }
    const t = SuggestionTimingsSchema.safeParse({
      utterance_end: utteranceEndAt.getTime(),
      suggestion_request_sent: requestSentAt.getTime(),
      first_token: firstTokenAt.getTime(),
      last_token: lastTokenAt.getTime(),
      rendered_in_client: clientRenderedAt.getTime(),
    });
    if (!t.success) {
      outOfOrder++;
      continue;
    }
    const d = t.data;
    samples++;
    values.pipeline.push(d.suggestion_request_sent - d.utterance_end);
    values.firstToken.push(d.first_token - d.suggestion_request_sent);
    values.stream.push(d.last_token - d.first_token);
    values.paint.push(d.rendered_in_client - d.last_token);
    values.toFirstToken.push(d.first_token - d.utterance_end);
    values.endToEnd.push(d.rendered_in_client - d.utterance_end);
  }
  return {
    suggestions: rows.length,
    samples,
    failed,
    incomplete,
    outOfOrder,
    stages: {
      pipeline: stats(values.pipeline),
      firstToken: stats(values.firstToken),
      stream: stats(values.stream),
      paint: stats(values.paint),
      toFirstToken: stats(values.toFirstToken),
      endToEnd: stats(values.endToEnd),
    },
  };
}

/** The same summary per prompt version (e.g. suggest-v1 vs suggest-v2), most samples first. */
export function summarizeLatencyByPromptVersion(
  rows: readonly TimingRow[],
): { promptVersion: string; summary: LatencySummary }[] {
  const groups = new Map<string, TimingRow[]>();
  for (const r of rows) {
    const g = groups.get(r.promptVersion) ?? [];
    g.push(r);
    groups.set(r.promptVersion, g);
  }
  return [...groups.entries()]
    .map(([promptVersion, g]) => ({ promptVersion, summary: summarizeLatency(g) }))
    .sort(
      (a, b) =>
        b.summary.samples - a.summary.samples || a.promptVersion.localeCompare(b.promptVersion),
    );
}
