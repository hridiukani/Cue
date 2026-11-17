import { type PlaybookInput, PlaybookInputSchema } from '@cue/shared';

/** Form field names shared by the client form and the server parser. */
export const FIELD = {
  name: 'name',
  productDescription: 'productDescription',
  idealCustomer: 'idealCustomer',
  toneNotes: 'toneNotes',
  objection: 'objection',
  goodResponse: 'good_response',
} as const;

/**
 * Field errors keyed by path: "name", "objections", "objections.2.good_response".
 * One message per field (the first), which is what the form shows.
 */
export type FieldErrors = Record<string, string>;

export type ParsedPlaybookForm =
  { ok: true; input: PlaybookInput } | { ok: false; fieldErrors: FieldErrors };

const str = (v: FormDataEntryValue | null): string => (typeof v === 'string' ? v : '');

/**
 * Turn submitted form data into validated playbook input. Objections arrive as
 * parallel repeated fields (objection[i], good_response[i]); rows where both
 * are blank are dropped, so an empty trailing row isn't an error. Anything not
 * in the schema (e.g. a smuggled userId) is ignored.
 */
export function parsePlaybookForm(formData: FormData): ParsedPlaybookForm {
  const objections = formData.getAll(FIELD.objection).map(str);
  const responses = formData.getAll(FIELD.goodResponse).map(str);
  const kept = Array.from({ length: Math.max(objections.length, responses.length) }, (_, i) => ({
    formIndex: i,
    row: { objection: objections[i] ?? '', good_response: responses[i] ?? '' },
  })).filter(({ row }) => row.objection.trim() !== '' || row.good_response.trim() !== '');
  const rows = kept.map((k) => k.row);

  const parsed = PlaybookInputSchema.safeParse({
    name: str(formData.get(FIELD.name)),
    productDescription: str(formData.get(FIELD.productDescription)),
    idealCustomer: str(formData.get(FIELD.idealCustomer)),
    toneNotes: str(formData.get(FIELD.toneNotes)),
    objections: rows,
  });
  if (parsed.success) return { ok: true, input: parsed.data };

  const fieldErrors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const path = issue.path.map(String);
    // Blank rows were dropped, so map "objections.<i>" back to the row the user sees.
    if (path[0] === 'objections' && path[1] !== undefined) {
      const formIndex = kept[Number(path[1])]?.formIndex;
      if (formIndex !== undefined) path[1] = String(formIndex);
    }
    const key = path.join('.') || 'form';
    fieldErrors[key] ??= issue.message;
  }
  return { ok: false, fieldErrors };
}
