import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { CaseRecord, CaseSummary, RunSummary } from './summary';

/**
 * Every eval run is saved as one JSON file in packages/evals/results/, named
 * by time, model and prompt version, with the git commit it ran at. That
 * folder is gitignored: results hold model output generated from datasets
 * that can't be redistributed (real-sales). CI uploads its file as an artifact.
 */

export const RESULTS_SCHEMA_VERSION = 1;

export interface RunMeta {
  runId: string;
  createdAt: string;
  git: { commit: string | null; dirty: boolean | null };
  model: string;
  judgeModel: string;
  judgeVersion: string;
  promptVersion: string;
  runsPerCase: number;
  concurrency: number;
  casesFile: { path: string; sha256: string };
  selection: { smoke: boolean; caseIds: string[] | null; categories: string[] | null };
  skipped: { caseId: string; reason: string }[];
  pricing: { url: string; checkedOn: string };
}

export interface RunFile {
  schemaVersion: number;
  meta: RunMeta;
  summary: RunSummary;
  cases: (CaseRecord & { summary: CaseSummary })[];
}

// What compare and the report read back. Loose: extra fields are fine, missing ones aren't.
const nullableNumber = z.number().nullable();
const RunFileSchema = z
  .object({
    schemaVersion: z.literal(RESULTS_SCHEMA_VERSION),
    meta: z
      .object({
        runId: z.string(),
        createdAt: z.string(),
        git: z.object({ commit: z.string().nullable(), dirty: z.boolean().nullable() }),
        model: z.string(),
        judgeModel: z.string(),
        judgeVersion: z.string(),
        promptVersion: z.string(),
        runsPerCase: z.number().int().positive(),
        casesFile: z.object({ path: z.string(), sha256: z.string() }),
      })
      .loose(),
    summary: z
      .object({
        cases: z.number(),
        runs: z.number(),
        passes: z.number(),
        passRate: z.number(),
        meanScore: nullableNumber,
        flakyCases: z.number(),
        firstTokenMs: z.object({ count: z.number(), p50: z.number(), p95: z.number() }).nullable(),
        costPer1000Usd: nullableNumber,
      })
      .loose(),
    cases: z.array(
      z
        .object({
          id: z.string(),
          category: z.string(),
          rubricHash: z.string(),
          summary: z
            .object({ passRate: z.number(), meanScore: nullableNumber, flaky: z.boolean() })
            .loose(),
        })
        .loose(),
    ),
  })
  .loose();

const slug = (s: string) => s.replace(/[^a-zA-Z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');

export function runFileName(meta: Pick<RunMeta, 'createdAt' | 'model' | 'promptVersion'>): string {
  const stamp = meta.createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${stamp}_${slug(meta.model)}_${slug(meta.promptVersion)}.json`;
}

export async function saveRun(dir: string, run: RunFile): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, runFileName(run.meta));
  await writeFile(file, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  return file;
}

export async function loadRun(file: string): Promise<RunFile> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new Error(`Can't read ${file}: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  const parsed = RunFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`${file} is not an eval run file:\n${z.prettifyError(parsed.error)}`);
  }
  // Validated where compare and the report read it; the rest is passed through.
  return json as RunFile;
}

/** Saved runs, oldest first (file names start with their timestamp). */
export async function listRunFiles(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir);
    return names
      .filter((n) => /^\d{8}T\d{6}Z_.+\.json$/.test(n))
      .sort()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/**
 * Resolve how a run was named on the command line: "latest", "previous"
 * (the one before latest), a path to a file, or the start of a file name.
 */
export async function resolveRunRef(dir: string, ref: string): Promise<string> {
  const files = await listRunFiles(dir);
  if (ref === 'latest' || ref === 'previous') {
    const file = files.at(ref === 'latest' ? -1 : -2);
    if (!file) throw new Error(`No ${ref} run in ${dir}`);
    return file;
  }
  if (ref.endsWith('.json')) return path.resolve(ref);
  const matches = files.filter((f) => path.basename(f).startsWith(ref));
  if (matches.length === 1 && matches[0]) return matches[0];
  throw new Error(
    matches.length === 0
      ? `No run in ${dir} starts with "${ref}"`
      : `"${ref}" matches ${String(matches.length)} runs; use more of the name`,
  );
}

const exec = promisify(execFile);

/** The commit the eval ran at, and whether there were uncommitted changes (null if not a repo). */
export async function gitInfo(cwd: string): Promise<RunMeta['git']> {
  try {
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      exec('git', ['rev-parse', 'HEAD'], { cwd }),
      exec('git', ['status', '--porcelain', '--untracked-files=no'], { cwd }),
    ]);
    return { commit: head.trim(), dirty: status.trim().length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}
