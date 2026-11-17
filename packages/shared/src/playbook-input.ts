import { z } from 'zod';

export const PLAYBOOK_LIMITS = {
  name: 120,
  productDescription: 4000,
  idealCustomer: 4000,
  toneNotes: 2000,
  objectionText: 1000,
  objections: 25,
} as const;

const text = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} must be ${max} characters or fewer`);

export const PlaybookObjectionInputSchema = z.object({
  objection: text('Objection', PLAYBOOK_LIMITS.objectionText),
  good_response: text('Good response', PLAYBOOK_LIMITS.objectionText),
});

/**
 * What a user may submit to create or edit a playbook. Deliberately has no
 * user_id or id: ownership always comes from the session, never the client.
 */
export const PlaybookInputSchema = z.object({
  name: text('Name', PLAYBOOK_LIMITS.name),
  productDescription: text('Product description', PLAYBOOK_LIMITS.productDescription),
  idealCustomer: text('Ideal customer', PLAYBOOK_LIMITS.idealCustomer),
  objections: z
    .array(PlaybookObjectionInputSchema)
    .max(PLAYBOOK_LIMITS.objections, `At most ${PLAYBOOK_LIMITS.objections} objections`),
  toneNotes: z
    .string()
    .trim()
    .max(
      PLAYBOOK_LIMITS.toneNotes,
      `Tone notes must be ${PLAYBOOK_LIMITS.toneNotes} characters or fewer`,
    )
    .transform((s) => (s === '' ? null : s))
    .nullable(),
});

export type PlaybookInput = z.output<typeof PlaybookInputSchema>;
