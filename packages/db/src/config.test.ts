import { describe, expect, it } from 'vitest';
import { loadDbConfig, loadTestDbConfig } from './config';

describe('loadTestDbConfig', () => {
  it('reads TEST_DATABASE_URL', () => {
    expect(
      loadTestDbConfig({ TEST_DATABASE_URL: 'postgres://u:p@localhost:5434/postgres' }),
    ).toEqual({ databaseUrl: 'postgres://u:p@localhost:5434/postgres' });
  });

  it('explains how to fix a missing TEST_DATABASE_URL', () => {
    expect(() => loadTestDbConfig({})).toThrow(/TEST_DATABASE_URL is required/);
  });
});

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
