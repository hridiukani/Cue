import { describe, expect, it } from 'vitest';
import { isLocalDatabase, LICENSED_DATASETS, localOnlyViolation } from './local-only';

const LOCAL = 'postgres://cue:cue@localhost:5434/cue';
const SUPABASE =
  'postgresql://postgres.abcdefgh:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres?sslmode=require';

describe('isLocalDatabase', () => {
  it.each([
    [LOCAL, true],
    ['postgres://u:p@127.0.0.1:5432/x', true],
    ['postgres://u:p@[::1]:5432/x', true],
    [SUPABASE, false],
    ['postgres://u:p@db.internal:5432/x', false],
    ['not a url', false],
  ])('%s → %s', (url, local) => {
    expect(isLocalDatabase(url)).toBe(local);
  });
});

describe('localOnlyViolation', () => {
  it('lets real-sales into a local database', () => {
    expect(localOnlyViolation(['real-sales', 'gwenshap'], LOCAL)).toBeNull();
  });

  it('lets the licensed datasets into any database', () => {
    expect(localOnlyViolation([...LICENSED_DATASETS], SUPABASE)).toBeNull();
  });

  it('refuses real-sales for a remote database, and says why and what to run instead', () => {
    const msg = localOnlyViolation(['gwenshap', 'real-sales'], SUPABASE);
    expect(msg).toMatch(/Refusing to import real-sales/);
    expect(msg).toContain('aws-0-us-east-1.pooler.supabase.com');
    expect(msg).toMatch(/no stated license/);
    expect(msg).toMatch(/--dataset licensed \(gwenshap \+ saas\)/);
    expect(msg).not.toContain('pw'); // never echo the password
  });
});
