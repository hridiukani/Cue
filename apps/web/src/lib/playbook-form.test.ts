import { describe, expect, it } from 'vitest';
import { FIELD, parsePlaybookForm } from './playbook-form';

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of Array.isArray(value) ? value : [value]) fd.append(key, v);
  }
  return fd;
}

const base = {
  [FIELD.name]: 'Outbound',
  [FIELD.productDescription]: 'Invoice matching',
  [FIELD.idealCustomer]: 'Finance teams',
  [FIELD.toneNotes]: '',
};

describe('parsePlaybookForm', () => {
  it('zips repeated objection fields into pairs', () => {
    const r = parsePlaybookForm(
      form({
        ...base,
        [FIELD.objection]: ['Too expensive', 'Bad timing'],
        [FIELD.goodResponse]: ['Compare to cost', 'Offer next month'],
      }),
    );
    expect(r).toEqual({
      ok: true,
      input: {
        name: 'Outbound',
        productDescription: 'Invoice matching',
        idealCustomer: 'Finance teams',
        toneNotes: null,
        objections: [
          { objection: 'Too expensive', good_response: 'Compare to cost' },
          { objection: 'Bad timing', good_response: 'Offer next month' },
        ],
      },
    });
  });

  it('drops fully blank objection rows', () => {
    const r = parsePlaybookForm(
      form({ ...base, [FIELD.objection]: ['', '  '], [FIELD.goodResponse]: ['', ''] }),
    );
    expect(r.ok && r.input.objections).toEqual([]);
  });

  it('reports a half-filled objection row at its index', () => {
    const r = parsePlaybookForm(
      form({
        ...base,
        [FIELD.objection]: ['Too expensive', 'Bad timing'],
        [FIELD.goodResponse]: ['Compare to cost', ''],
      }),
    );
    expect(r).toEqual({
      ok: false,
      fieldErrors: { 'objections.1.good_response': 'Good response is required' },
    });
  });

  it('points errors at the row the user sees, even after a blank row is dropped', () => {
    const r = parsePlaybookForm(
      form({
        ...base,
        [FIELD.objection]: ['', 'Bad timing'],
        [FIELD.goodResponse]: ['', ''],
      }),
    );
    expect(!r.ok && r.fieldErrors).toEqual({
      'objections.1.good_response': 'Good response is required',
    });
  });

  it('reports every missing required field', () => {
    const r = parsePlaybookForm(form({}));
    expect(r.ok).toBe(false);
    expect(!r.ok && Object.keys(r.fieldErrors).sort()).toEqual([
      'idealCustomer',
      'name',
      'productDescription',
    ]);
  });

  it('ignores fields outside the schema, like a smuggled userId', () => {
    const r = parsePlaybookForm(form({ ...base, userId: 'someone-else' }));
    expect(r.ok && r.input).not.toHaveProperty('userId');
  });
});
