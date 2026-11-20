import { describe, expect, it } from 'vitest';
import { DatabasePoolMaxSchema } from './env';

describe('DatabasePoolMaxSchema', () => {
  it('treats unset or empty as "driver default"', () => {
    expect(DatabasePoolMaxSchema.parse(undefined)).toBeUndefined();
    expect(DatabasePoolMaxSchema.parse('  ')).toBeUndefined();
  });

  it('reads a positive integer', () => {
    expect(DatabasePoolMaxSchema.parse('1')).toBe(1);
    expect(DatabasePoolMaxSchema.parse(' 5 ')).toBe(5);
  });

  it.each(['0', '-1', '2.5', 'ten', '101'])('rejects %j', (v) => {
    expect(DatabasePoolMaxSchema.safeParse(v).success).toBe(false);
  });
});
