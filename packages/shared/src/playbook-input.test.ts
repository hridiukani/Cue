import { describe, expect, it } from 'vitest';
import { PLAYBOOK_LIMITS, PlaybookInputSchema } from './playbook-input';

const valid = {
  name: '  Outbound  ',
  productDescription: 'Invoice matching',
  idealCustomer: 'Mid-market finance teams',
  objections: [{ objection: 'Too expensive', good_response: 'Compare to current cost' }],
  toneNotes: '',
};

describe('PlaybookInputSchema', () => {
  it('trims strings and turns empty tone notes into null', () => {
    expect(PlaybookInputSchema.parse(valid)).toMatchObject({ name: 'Outbound', toneNotes: null });
  });

  it('allows zero objections', () => {
    expect(PlaybookInputSchema.safeParse({ ...valid, objections: [] }).success).toBe(true);
  });

  it('rejects whitespace-only required fields with a readable message', () => {
    const r = PlaybookInputSchema.safeParse({ ...valid, idealCustomer: '   ' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]).toMatchObject({
      path: ['idealCustomer'],
      message: 'Ideal customer is required',
    });
  });

  it('points errors at the exact objection field', () => {
    const r = PlaybookInputSchema.safeParse({
      ...valid,
      objections: [valid.objections[0], { objection: 'Timing', good_response: '' }],
    });
    expect(r.error?.issues[0]?.path).toEqual(['objections', 1, 'good_response']);
  });

  it('caps lengths and the number of objections', () => {
    expect(
      PlaybookInputSchema.safeParse({ ...valid, name: 'x'.repeat(PLAYBOOK_LIMITS.name + 1) })
        .success,
    ).toBe(false);
    const tooMany = Array.from(
      { length: PLAYBOOK_LIMITS.objections + 1 },
      () => valid.objections[0],
    );
    expect(PlaybookInputSchema.safeParse({ ...valid, objections: tooMany }).success).toBe(false);
  });

  it('strips fields a client might try to smuggle in, like userId', () => {
    const parsed = PlaybookInputSchema.parse({ ...valid, userId: 'someone-else', id: 'x' });
    expect(parsed).not.toHaveProperty('userId');
    expect(parsed).not.toHaveProperty('id');
  });
});
