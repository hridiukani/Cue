import { describe, expect, it } from 'vitest';
import { createDb } from './client';

// postgres.js connects lazily: creating a client opens no connection.
const URL = 'postgres://u:p@127.0.0.1:1/unused';

describe('createDb', () => {
  it("uses the driver's default pool size when no max is given", async () => {
    const { db, close } = createDb(URL);
    expect(db.$client.options.max).toBe(10);
    await close();
  });

  it('caps the pool at max (DATABASE_POOL_MAX, for the Supabase Session pooler)', async () => {
    const { db, close } = createDb(URL, { max: 1 });
    expect(db.$client.options.max).toBe(1);
    await close();
  });
});
