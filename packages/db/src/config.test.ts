import { describe, expect, it } from 'vitest';
import { loadDbConfig } from './config';

describe('loadDbConfig', () => {
  it('reads a postgres DATABASE_URL', () => {
    expect(loadDbConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/cue' })).toEqual({
      databaseUrl: 'postgres://u:p@localhost:5432/cue',
    });
  });

  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadDbConfig({})).toThrow(/DATABASE_URL/);
  });

  it('throws for a non-postgres URL', () => {
    expect(() => loadDbConfig({ DATABASE_URL: 'mysql://localhost/cue' })).toThrow(/postgres/);
  });
});
