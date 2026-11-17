import { describe, expect, it, vi } from 'vitest';
import { HfClient } from './hf-client';
import type { FetchFn } from './http';

type Route = (url: string, init?: RequestInit) => Response | undefined;

/** A fake fetch that answers from routes and records every request. */
function fakeFetch(...routes: Route[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fn: FetchFn = (url, init) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    for (const r of routes) {
      const res = r(url, init);
      if (res) return Promise.resolve(res);
    }
    return Promise.resolve(new Response('not routed', { status: 599 }));
  };
  return { fn, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const noSleep = () => Promise.resolve();

describe('HfClient.probe', () => {
  it('returns revision and license for a public dataset', async () => {
    const { fn } = fakeFetch((u) =>
      u.endsWith('/api/datasets/org/public')
        ? json({ sha: 'abc123', gated: false, cardData: { license: 'apache-2.0' } })
        : undefined,
    );
    expect(await new HfClient({ fetch: fn }).probe('org/public')).toEqual({
      ok: true,
      revision: 'abc123',
      license: 'apache-2.0',
      gated: false,
    });
  });

  it("reports 'unspecified' when the card states no license", async () => {
    const { fn } = fakeFetch(() => json({ sha: 's', gated: false, cardData: {} }));
    expect(await new HfClient({ fetch: fn }).probe('org/x')).toMatchObject({
      license: 'unspecified',
    });
  });

  it('explains a missing dataset', async () => {
    const { fn } = fakeFetch(() => json({ error: 'not found' }, 404));
    const r = await new HfClient({ fetch: fn }).probe('liva-ai/mock-sales');
    expect(r).toMatchObject({ ok: false, reason: 'not_found' });
    expect(!r.ok && r.message).toContain('https://huggingface.co/datasets/liva-ai/mock-sales');
  });

  it('asks for HF_TOKEN when unauthenticated access is refused', async () => {
    const { fn } = fakeFetch(() => json({ error: 'Invalid username or password.' }, 401));
    const r = await new HfClient({ fetch: fn }).probe('org/gated');
    expect(r).toMatchObject({ ok: false, reason: 'needs_token' });
    expect(!r.ok && r.message).toMatch(/HF_TOKEN/);
    expect(!r.ok && r.message).toContain('https://huggingface.co/settings/tokens');
  });

  it('asks to accept terms when the token cannot read a gated dataset', async () => {
    const { fn } = fakeFetch(
      (u) => (u.includes('/tree/') ? json({ error: 'gated' }, 403) : undefined),
      () => json({ sha: 's', gated: 'manual', cardData: {} }),
    );
    const r = await new HfClient({ fetch: fn, token: 'hf_test' }).probe('org/gated');
    expect(r).toMatchObject({ ok: false, reason: 'terms_not_accepted' });
  });

  it('accepts a gated dataset when the file listing is readable', async () => {
    const { fn } = fakeFetch(
      (u) => (u.includes('/tree/') ? json([]) : undefined),
      () => json({ sha: 's', gated: 'auto', cardData: { license: ['cc-by-4.0'] } }),
    );
    expect(await new HfClient({ fetch: fn, token: 'hf_test' }).probe('org/gated')).toMatchObject({
      ok: true,
      gated: true,
      license: 'cc-by-4.0',
    });
  });

  it('sends the token as a bearer header and a generic user agent', async () => {
    const { fn, calls } = fakeFetch(() => json({ sha: 's', gated: false }));
    await new HfClient({ fetch: fn, token: 'hf_secret' }).probe('org/x');
    expect(calls[0]?.headers).toEqual({
      'user-agent': 'cue-ingest/0.1',
      authorization: 'Bearer hf_secret',
    });
  });
});

describe('HfClient retries', () => {
  it('retries a 503 and honors Retry-After', async () => {
    let n = 0;
    const { fn } = fakeFetch(() =>
      ++n === 1
        ? new Response('busy', { status: 503, headers: { 'retry-after': '2' } })
        : json({ sha: 's', gated: false }),
    );
    const sleep = vi.fn(noSleep);
    const r = await new HfClient({ fetch: fn, sleep }).probe('org/x');
    expect(r.ok).toBe(true);
    expect(sleep).toHaveBeenCalledWith(2000);
  });
});

describe('HfClient.rows', () => {
  it('uses /filter when given a where clause, /rows otherwise', async () => {
    const { fn, calls } = fakeFetch(() => json({ rows: [{ row: { a: 1 } }], num_rows_total: 1 }));
    const hf = new HfClient({ fetch: fn });
    await hf.rows('org/x', { config: 'default', split: 'train', offset: 0, length: 10 });
    await hf.rows('org/x', {
      config: 'default',
      split: 'train',
      offset: 0,
      length: 10,
      where: `"channel"='phone_call'`,
    });
    expect(calls[0]?.url).toContain('datasets-server.huggingface.co/rows?');
    expect(calls[1]?.url).toContain('datasets-server.huggingface.co/filter?');
    expect(decodeURIComponent(calls[1]?.url ?? '')).toContain(`where="channel"='phone_call'`);
  });
});
