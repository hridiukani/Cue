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
