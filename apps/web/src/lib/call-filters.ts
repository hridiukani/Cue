import { z } from 'zod';

/** Library filters, read from the URL query string (so filtered views can be linked). */

const MIN = 60_000;

export const DURATION_BUCKETS = {
  short: { label: 'Under 5 min', minMs: undefined, maxMs: 5 * MIN },
  medium: { label: '5–15 min', minMs: 5 * MIN, maxMs: 15 * MIN },
  long: { label: 'Over 15 min', minMs: 15 * MIN, maxMs: undefined },
} as const;
export type DurationBucket = keyof typeof DURATION_BUCKETS;

export const SOURCE_TYPES = {
  audio: 'Has audio',
  transcript: 'Transcript only',
} as const;
export type SourceType = keyof typeof SOURCE_TYPES;

export const PAGE_SIZE = 20;

export interface CallFilters {
  dataset: string | undefined;
  duration: DurationBucket | undefined;
  source: SourceType | undefined;
  page: number;
}

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const DurationSchema = z.enum(['short', 'medium', 'long']);
const SourceSchema = z.enum(['audio', 'transcript']);
const PageSchema = z.coerce.number().int().min(1).max(10_000);
const DatasetSchema = z.string().min(1).max(200);

/** Parse untrusted query params. Anything invalid is ignored rather than erroring. */
export function parseCallFilters(
  params: Record<string, string | string[] | undefined>,
): CallFilters {
  const pick = <T>(schema: z.ZodType<T>, v: string | undefined): T | undefined => {
    const r = schema.safeParse(v);
    return r.success ? r.data : undefined;
  };
  return {
    dataset: pick(DatasetSchema, first(params.dataset)), // min(1) also rejects ""
    duration: pick(DurationSchema, first(params.duration)),
    source: pick(SourceSchema, first(params.source)),
    page: pick(PageSchema, first(params.page)) ?? 1,
  };
}

/** Convert UI filters to the repository's query. */
export function toRecordingQuery(f: CallFilters) {
  const bucket = f.duration ? DURATION_BUCKETS[f.duration] : undefined;
  return {
    datasetId: f.dataset,
    minDurationMs: bucket?.minMs,
    maxDurationMs: bucket?.maxMs,
    hasAudio: f.source === undefined ? undefined : f.source === 'audio',
    limit: PAGE_SIZE,
    offset: (f.page - 1) * PAGE_SIZE,
  };
}

/** Query string for a link, keeping current filters and applying overrides. */
export function filtersToQuery(f: CallFilters, overrides: Partial<CallFilters> = {}): string {
  const merged = { ...f, ...overrides };
  const q = new URLSearchParams();
  if (merged.dataset) q.set('dataset', merged.dataset);
  if (merged.duration) q.set('duration', merged.duration);
  if (merged.source) q.set('source', merged.source);
  if (merged.page > 1) q.set('page', String(merged.page));
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** 754_000 → "12:34", 3_725_000 → "1:02:05". */
export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${String(h)}:${pad(m)}:${pad(s)}` : `${String(m)}:${pad(s)}`;
}
