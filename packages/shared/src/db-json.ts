import { z } from 'zod';

/**
 * Shapes of the jsonb columns in packages/db. The DB stores whatever JSON it is
 * given, so anything read from or written to these columns is validated here.
 */

/** playbooks.objections: objections the rep expects, with a good answer to each. */
export const PlaybookObjectionSchema = z
  .object({
    objection: z.string().min(1),
    good_response: z.string().min(1),
  })
  .strict();
export const PlaybookObjectionsSchema = z.array(PlaybookObjectionSchema);
export type PlaybookObjection = z.infer<typeof PlaybookObjectionSchema>;

/** call_summaries.objections_raised: objections that actually came up on the call. */
export const RaisedObjectionSchema = z
  .object({
    objection: z.string().min(1),
    rep_response: z.string().min(1).nullable(),
    handled: z.boolean(),
  })
  .strict();
export const RaisedObjectionsSchema = z.array(RaisedObjectionSchema);
export type RaisedObjection = z.infer<typeof RaisedObjectionSchema>;

/** call_summaries.next_steps: agreed follow-ups. `due` is an ISO date (YYYY-MM-DD). */
export const NextStepSchema = z
  .object({
    action: z.string().min(1),
    owner: z.enum(['rep', 'prospect']),
    due: z.iso.date().optional(),
  })
  .strict();
export const NextStepsSchema = z.array(NextStepSchema);
export type NextStep = z.infer<typeof NextStepSchema>;

/** call_summaries.coaching_notes: feedback for the rep, optionally pinned to an utterance. */
export const CoachingNoteSchema = z
  .object({
    note: z.string().min(1),
    utterance_id: z.uuid().optional(),
  })
  .strict();
export const CoachingNotesSchema = z.array(CoachingNoteSchema);
export type CoachingNote = z.infer<typeof CoachingNoteSchema>;

/**
 * recordings.metadata: small, flat, allowlisted facts about an imported
 * recording (e.g. product type, outcome). Never personal or demographic data.
 * Each ingest adapter picks fields from an explicit allowlist; this schema is
 * a second line of defense that refuses demographic-looking keys outright.
 */
const DEMOGRAPHIC_WORDS = new Set([
  'age',
  'gender',
  'sex',
  'ethnicity',
  'ethnic',
  'race',
  'nationality',
  'religion',
  'demographic',
  'demographics',
]);

/** Whole-word match on a key split at _ - . and camelCase, so "language" is fine but "seller_age_range" is not. */
export function isDemographicKey(key: string): boolean {
  const words = key
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.some((w) => DEMOGRAPHIC_WORDS.has(w))) return true;
  // "grew_up_in" / "grewUpIn": where someone is from.
  return words.some((w, i) => w === 'grew' && words[i + 1] === 'up');
}

export const RecordingMetadataSchema = z
  .record(
    z.string().min(1).max(64),
    z.union([z.string().max(500), z.number(), z.boolean(), z.null()]),
  )
  .refine((m) => Object.keys(m).length <= 20, 'At most 20 metadata fields')
  .refine((m) => !Object.keys(m).some(isDemographicKey), {
    message: 'Demographic fields must not be stored in recording metadata',
  });
export type RecordingMetadata = z.infer<typeof RecordingMetadataSchema>;
