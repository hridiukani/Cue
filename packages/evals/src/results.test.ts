import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeCase, fakeRunFile } from './fixtures.test-helpers';
import { COLOR, formatRun } from './report';
import { gitInfo, listRunFiles, loadRun, resolveRunRef, runFileName, saveRun } from './results';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'cue-evals-'));
});
afterEach(async () => {
  // Windows keeps a folder locked briefly after a git process ran in it: retry.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('results store', () => {
  it('names files by time, model and prompt version', () => {
    expect(
      runFileName({
        createdAt: '2026-11-17T12:34:56.789Z',
        model: 'openai/gpt-oss-20b',
        promptVersion: 'suggest-v1',
      }),
    ).toBe('20261117T123456Z_openai-gpt-oss-20b_suggest-v1.json');
  });

  it('round-trips a run, and resolves latest / previous / a name prefix', async () => {
    const older = fakeRunFile([fakeCase('a', 3, 3)], { createdAt: '2026-11-16T10:00:00.000Z' });
    const newer = fakeRunFile([fakeCase('a', 2, 3)], { createdAt: '2026-11-17T10:00:00.000Z' });
    const f1 = await saveRun(dir, older);
    const f2 = await saveRun(dir, newer);
    await writeFile(path.join(dir, 'notes.txt'), 'ignored');

    expect(await listRunFiles(dir)).toEqual([f1, f2]);
    expect(await loadRun(f2)).toEqual(newer);
    expect(await resolveRunRef(dir, 'latest')).toBe(f2);
    expect(await resolveRunRef(dir, 'previous')).toBe(f1);
    expect(await resolveRunRef(dir, '20261116')).toBe(f1);
    await expect(resolveRunRef(dir, '2026111')).rejects.toThrow(/matches 2 runs/);
    await expect(resolveRunRef(dir, 'zzz')).rejects.toThrow(/No run/);
  });

  it('says so when there is no previous run', async () => {
    await saveRun(dir, fakeRunFile([fakeCase('a', 3, 3)]));
    await expect(resolveRunRef(dir, 'previous')).rejects.toThrow(/No previous run/);
    expect(await listRunFiles(path.join(dir, 'missing'))).toEqual([]);
  });

  it('rejects files that are not run files, with the reason', async () => {
    const bad = path.join(dir, 'bad.json');
    await writeFile(bad, JSON.stringify({ schemaVersion: 1, meta: {} }));
    await expect(loadRun(bad)).rejects.toThrow(/not an eval run file/);
    const junk = path.join(dir, 'junk.json');
    await writeFile(junk, '{nope');
    await expect(loadRun(junk)).rejects.toThrow(/Can't read/);
  });

  it('reads the git commit of this repo', async () => {
    const info = await gitInfo(process.cwd());
    expect(info.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof info.dirty).toBe('boolean');
    expect(await gitInfo(dir)).toEqual({ commit: null, dirty: null }); // not a repo
  });
});

describe('formatRun', () => {
  const run = fakeRunFile([
    fakeCase('price-01', 3, 3),
    fakeCase('email-01', 0, 3, { category: 'send_email' }),
  ]);

  it('prints the headline metrics, categories and each case', () => {
    const text = formatRun(run);
    expect(text).toContain(
      'model openai/gpt-oss-20b · prompt suggest-v1 · judge openai/gpt-oss-120b (judge-v1) · N=3 · abcdef1',
    );
    expect(text).toMatch(/Pass rate\s+50\.0% \(3\/6 graded runs\)/);
    expect(text).toMatch(/Ungraded\s+0\n/);
    expect(text).not.toMatch(/runs \(.*\): the judge failed/); // no banner when all graded
    expect(text).toMatch(/First token p50 \/ p95\s+300 ms \/ 300 ms \(6 samples · 0 over 1\.5 s\)/);
    expect(text).toMatch(/Cost per 1,000\s+\$0\.0555 \(model under test, 6 costed runs\)/);
    expect(text).toMatch(/send_email\s+0\.0%\s+3\/3\s+0/);
    expect(text).toMatch(/email-01\s+send_email\s+0\/3\s+2\.0\s+0\.0\s+score 2 < 4/);
  });

  it('puts ungraded runs up front and tells you how to grade them', () => {
    const c = fakeCase('price-01', 2, 3);
    const last = c.runs[2];
    if (last) {
      Object.assign(last, {
        verdict: null,
        judgeError: 'judge HTTP 429',
        score: null,
        pass: false,
        reasons: ['ungraded: judge HTTP 429'],
      });
    }
    const text = formatRun(fakeRunFile([c]));
    expect(text).toContain('Ungraded: 1 of 3 runs (33.3%): the judge failed on them');
    expect(text).toContain('pnpm eval rejudge');
    expect(text).toMatch(/Pass rate\s+100\.0% \(2\/2 graded runs\)/);
    expect(text).toMatch(/Errors\s+1 \(model 0 · ungraded 1\)/);
    expect(text).toMatch(/price-01\s+price_objection\s+2\/2 \(\+1\?\)/);
  });

  it('re-counts an old file on load, so a judge 429 is no longer a failure', async () => {
    // Files from before this rule saved a summary that counted ungraded runs as failures.
    const c = fakeCase('a', 1, 2);
    const second = c.runs[1];
    if (second) Object.assign(second, { verdict: null, judgeError: 'judge HTTP 429', score: null });
    const stale = fakeRunFile([c]);
    Object.assign(stale.summary, { passRate: 0.5, passes: 1, errors: 0 });
    const loaded = await loadRun(await saveRun(dir, stale));
    expect(loaded.summary).toMatchObject({ passRate: 1, graded: 1, ungraded: 1, errors: 1 });
    expect(loaded.cases[0]?.summary).toMatchObject({ passRate: 1, ungraded: 1 });
  });

  it('colours only when asked', () => {
    expect(formatRun(run).includes('\u001b[')).toBe(false);
    expect(formatRun(run, COLOR).includes('\u001b[31m0/3')).toBe(true); // never passes: red
  });
});
