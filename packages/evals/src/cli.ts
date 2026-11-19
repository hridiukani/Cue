import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createDb,
  type Db,
  findRecordingByExternalId,
  getRecordingUtterances,
  listRecordingRefs,
} from '@cue/db';
import { loadRootEnvFile } from '@cue/db/node';
import { GroqClient, isKnownPromptVersion, PROMPT_VERSION, SYSTEM_PROMPTS } from '@cue/suggest';
import { candidateToCaseSkeleton, findCandidates, type ScanRecording } from './candidates';
import { CATEGORIES, type EvalCase, parseCases, sha256 } from './cases';
import { compareRuns } from './compare';
import { loadEvalConfig, useColor } from './config';
import {
  DEFAULT_JUDGE_SETTINGS,
  GroqJudgeClient,
  JUDGE_VERSION,
  type JudgeSettings,
  judgeSettingsKey,
  type ReasoningEffort,
  REJUDGE_SETTINGS,
} from './judge';
import { PRICING_SOURCE } from './pricing';
import {
  describeRateLimits,
  newRateLimitStats,
  type RateLimitStats,
  recordRateLimit,
} from './rate-limits';
import { REJUDGE_INTERVAL_S, REJUDGE_MAX_WAIT_S, rejudgeRun } from './rejudge';
import { COLOR, formatCompare, formatRun, PLAIN } from './report';
import { type LoadUtterances, parsePlaybooks, resolveCase, type ResolvedCase } from './resolve';
import { gitInfo, loadRun, resolveRunRef, type RunFile, saveRun } from './results';
import { DEFAULT_MAX_WAIT_MS, JudgeGate, runCases, type RunnerDeps } from './runner';
import { isUngraded } from './scoring';
import { runProblems, summarizeCase, summarizeRun } from './summary';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const CASES_FILE = path.join(PACKAGE_ROOT, 'dataset', 'cases.jsonl');
const PLAYBOOKS_FILE = path.join(PACKAGE_ROOT, 'dataset', 'playbooks.json');
const RESULTS_DIR = path.join(PACKAGE_ROOT, 'results');
const CANDIDATES_DIR = path.join(PACKAGE_ROOT, 'candidates');

const USAGE = `Usage:
  pnpm eval [run] [options]          run the eval and save the result
  pnpm eval rejudge <run>            grade a saved run's ungraded lines (nothing regenerated)
  pnpm eval compare <A> <B>          diff two saved runs (B = after)
  pnpm eval candidates [options]     scan imported calls for candidate moments
  pnpm eval cases                    validate dataset/cases.jsonl and summarise it

run options:
  --model <id>            model under test (default: GROQ_MODEL or openai/gpt-oss-20b)
  --prompt-version <v>    system prompt version (default: ${PROMPT_VERSION}; known: ${Object.keys(SYSTEM_PROMPTS).join(', ')})
  --runs <n>              generations per case, to measure variance (default 3)
  --judge-model <id>      judge model, must differ from --model (default: EVAL_JUDGE_MODEL or openai/gpt-oss-120b)
  --smoke                 only the smoke subset (what CI runs)
  --case <id>             only this case (repeatable)
  --category <name>       only this category (repeatable): ${CATEGORIES.join(', ')}
  --concurrency <n>       generations in parallel (default 4)
  --judge-concurrency <n> judge calls in parallel (default 1; providers limit tokens per minute)
  --judge-effort <e>      judge reasoning effort: low, medium, high (default medium)
  --judge-max-tokens <n>  judge token budget, hidden reasoning included (default 1024)
  --judge-interval <s>    at least this many seconds between judge calls (default 0)
  --max-wait <s>          longest provider retry-after to wait out (default 120); a longer
                          one leaves the remaining lines ungraded, for pnpm eval rejudge
  --min-pass-rate <0-1>   exit 1 if the pass rate is below this
                          (it also exits 1 if more than 5% of runs are ungraded)
  --json <file>           also write the summary as JSON here
  --markdown <file>       append the report as Markdown (e.g. $GITHUB_STEP_SUMMARY)
  --no-db                 don't connect to the database (cases that need it are skipped)

rejudge options (writes a new results file; the original is kept):
  <run> is "latest", "previous", a file path, or the start of a file name in results/
  --judge-effort <e>      default low
  --judge-max-tokens <n>  default 512
  --judge-interval <s>    default ${String(REJUDGE_INTERVAL_S)}
  --max-wait <s>          default ${String(REJUDGE_MAX_WAIT_S)}
  --judge-concurrency <n> default 1

compare options:
  A and B are "latest", "previous", a file path, or the start of a file name in results/
  --fail-on-regression    exit 1 if any case regressed

candidates options:
  --per-category <n>      candidates per category (default 10)`;

function positiveInt(v: string | undefined, flag: string, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${flag} must be a positive integer`);
  return n;
}

function connectDb(databaseUrl: string | undefined): { db: Db; close: () => Promise<void> } | null {
  if (!databaseUrl) return null;
  return createDb(databaseUrl);
}

function dbLoader(db: Db): LoadUtterances {
  return async (dataset, callId) => {
    const ref = await findRecordingByExternalId(db, dataset, callId);
    if (!ref) return null;
    const rows = await getRecordingUtterances(db, ref.id);
    return rows.map((r) => ({ idx: r.idx, speaker: r.speaker, text: r.text }));
  };
}

async function readCases(): Promise<{ cases: EvalCase[]; sha: string }> {
  const text = await readFile(CASES_FILE, 'utf8');
  return { cases: parseCases(text), sha: sha256(text) };
}

// ------------------------------------------------------------------ run

async function cmdRun(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      model: { type: 'string' },
      'prompt-version': { type: 'string' },
      runs: { type: 'string' },
      'judge-model': { type: 'string' },
      smoke: { type: 'boolean', default: false },
      case: { type: 'string', multiple: true },
      category: { type: 'string', multiple: true },
      concurrency: { type: 'string' },
      'judge-concurrency': { type: 'string' },
      ...JUDGE_FLAGS,
      'min-pass-rate': { type: 'string' },
      json: { type: 'string' },
      markdown: { type: 'string' },
      'no-db': { type: 'boolean', default: false },
    },
    strict: true,
  });
  const judgeOpts = judgeFlags(values, {
    settings: DEFAULT_JUDGE_SETTINGS,
    intervalS: 0,
    maxWaitS: DEFAULT_MAX_WAIT_MS / 1000,
  });
  const config = loadEvalConfig();
  const model = values.model ?? config.defaultModel;
  const judgeModel = values['judge-model'] ?? config.judgeModel;
  const promptVersion = values['prompt-version'] ?? PROMPT_VERSION;
  const runsPerCase = positiveInt(values.runs, '--runs', 3);
  const concurrency = positiveInt(values.concurrency, '--concurrency', 4);
  const judgeConcurrency = positiveInt(values['judge-concurrency'], '--judge-concurrency', 1);
  const minPassRate =
    values['min-pass-rate'] === undefined ? null : Number(values['min-pass-rate']);
  if (minPassRate !== null && !(minPassRate >= 0 && minPassRate <= 1)) {
    throw new Error('--min-pass-rate must be between 0 and 1');
  }
  if (!isKnownPromptVersion(promptVersion)) {
    throw new Error(
      `Unknown --prompt-version "${promptVersion}". Known: ${Object.keys(SYSTEM_PROMPTS).join(', ')}`,
    );
  }
  if (judgeModel === model) {
    throw new Error(
      `The judge must be a different model from the one under test (both are ${model}).`,
    );
  }
  if (!config.groqApiKey) throw new Error('GROQ_API_KEY is not set (.env, or the CI secret).');
  const categories = values.category ?? null;
  for (const c of categories ?? []) {
    if (!(CATEGORIES as readonly string[]).includes(c))
      throw new Error(`Unknown --category "${c}"`);
  }

  const { cases: all, sha } = await readCases();
  const selected = all.filter(
    (c) =>
      (!values.smoke || c.smoke) &&
      (!values.case || values.case.includes(c.id)) &&
      (!categories || categories.includes(c.category)),
  );
  const unknownIds = (values.case ?? []).filter((id) => !all.some((c) => c.id === id));
  if (unknownIds.length > 0) throw new Error(`Unknown --case: ${unknownIds.join(', ')}`);
  if (selected.length === 0) throw new Error('No cases selected.');

  const playbooks = parsePlaybooks(await readFile(PLAYBOOKS_FILE, 'utf8'));
  const needsDb = selected.some((c) => c.window === null);
  const conn = needsDb && !values['no-db'] ? connectDb(config.databaseUrl) : null;
  try {
    const resolved: ResolvedCase[] = [];
    const skipped: { caseId: string; reason: string }[] = [];
    for (const c of selected) {
      let r;
      try {
        r = await resolveCase(c, playbooks, conn ? dbLoader(conn.db) : null);
      } catch (err) {
        r = {
          ok: false as const,
          caseId: c.id,
          reason: `database: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      if (r.ok) resolved.push(r.resolved);
      else skipped.push({ caseId: r.caseId, reason: r.reason });
    }
    if (resolved.length === 0) {
      console.error(skipped.map((s) => `${s.caseId}: ${s.reason}`).join('\n'));
      throw new Error('Every selected case was skipped.');
    }

    console.log(
      `Running ${String(resolved.length)} case(s) × ${String(runsPerCase)} with ${model} (prompt ${promptVersion}), judged by ${judgeModel}${skipped.length ? `; skipping ${String(skipped.length)}` : ''}`,
    );
    const total = resolved.length * runsPerCase;
    let done = 0;
    const rateLimits = newRateLimitStats();
    const records = await runCases(
      resolved,
      {
        model,
        promptVersion,
        runsPerCase,
        concurrency,
        judgeConcurrency,
        judgeMinIntervalMs: judgeOpts.intervalMs,
        maxWaitMs: judgeOpts.maxWaitMs,
      },
      {
        llm: new GroqClient({ apiKey: config.groqApiKey, baseUrl: config.groqBaseUrl }),
        judge: new GroqJudgeClient(judgeModel, {
          apiKey: config.groqApiKey,
          baseUrl: config.groqBaseUrl,
          settings: judgeOpts.settings,
        }),
        now: () => performance.now(),
        sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
        timeout: (ms) => AbortSignal.timeout(ms),
        onRateLimited: rateLimitProgress(rateLimits),
        onRunDone: (_id, run) => {
          done++;
          // E = model error, U = ungraded (the judge failed), F = graded fail.
          process.stdout.write(run.error ? 'E' : isUngraded(run) ? 'U' : run.pass ? '.' : 'F');
          if (done % 60 === 0 || done === total)
            process.stdout.write(` ${String(done)}/${String(total)}\n`);
        },
      },
    );

    const run: RunFile = {
      schemaVersion: 1,
      meta: {
        runId: randomUUID(),
        createdAt: new Date().toISOString(),
        git: await gitInfo(REPO_ROOT),
        model,
        judgeModel,
        judgeVersion: JUDGE_VERSION,
        promptVersion,
        runsPerCase,
        concurrency,
        casesFile: { path: path.relative(REPO_ROOT, CASES_FILE).replace(/\\/g, '/'), sha256: sha },
        selection: { smoke: values.smoke, caseIds: values.case ?? null, categories },
        skipped,
        pricing: { ...PRICING_SOURCE },
        judgeSettings: judgeOpts.settings,
        rateLimits,
      },
      summary: summarizeRun(records, { model, judgeModel }),
      cases: records.map((r) => ({ ...r, summary: summarizeCase(r) })),
    };
    const file = await saveRun(RESULTS_DIR, run);
    console.log(`\n${formatRun(run, useColor(process.stdout.isTTY) ? COLOR : PLAIN)}`);
    printRateLimits(rateLimits);
    console.log(`\nSaved ${path.relative(process.cwd(), file)}`);
    // pnpm runs this script inside packages/evals: resolve paths from where the command was typed.
    const out = (p: string | undefined) => (p ? path.resolve(config.invocationDir, p) : undefined);
    const jsonOut = out(values.json);
    const markdownOut = out(values.markdown);
    if (jsonOut) {
      await mkdir(path.dirname(jsonOut), { recursive: true });
      await writeFile(
        jsonOut,
        `${JSON.stringify({ meta: run.meta, summary: run.summary }, null, 2)}\n`,
      );
    }
    if (markdownOut) {
      await appendFile(
        markdownOut,
        `### Suggestion eval\n\n\`\`\`text\n${formatRun(run)}\n\`\`\`\n`,
      );
    }
    return reportProblems(
      runProblems(run.summary, { minPassRate, file: path.relative(process.cwd(), file) }),
    );
  } finally {
    await conn?.close();
  }
}

function reportProblems(problems: readonly string[]): number {
  for (const p of problems) console.error(`\n${p}`);
  return problems.length > 0 ? 1 : 0;
}

// ------------------------------------------------------------------ judge flags

const JUDGE_FLAGS = {
  'judge-effort': { type: 'string' },
  'judge-max-tokens': { type: 'string' },
  'judge-interval': { type: 'string' },
  'max-wait': { type: 'string' },
} as const;

const EFFORTS: readonly ReasoningEffort[] = ['low', 'medium', 'high'];

function nonNegativeSeconds(v: string | undefined, flag: string, fallback: number): number {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} must be a number of seconds ≥ 0`);
  return n;
}

function judgeFlags(
  values: {
    'judge-effort'?: string;
    'judge-max-tokens'?: string;
    'judge-interval'?: string;
    'max-wait'?: string;
  },
  defaults: { settings: JudgeSettings; intervalS: number; maxWaitS: number },
): { settings: JudgeSettings; intervalMs: number; maxWaitMs: number } {
  const effort = values['judge-effort'] ?? defaults.settings.reasoningEffort;
  const reasoningEffort = EFFORTS.find((e) => e === effort);
  if (!reasoningEffort) throw new Error(`--judge-effort must be one of ${EFFORTS.join(', ')}`);
  return {
    settings: {
      reasoningEffort,
      maxCompletionTokens: positiveInt(
        values['judge-max-tokens'],
        '--judge-max-tokens',
        defaults.settings.maxCompletionTokens,
      ),
    },
    intervalMs:
      nonNegativeSeconds(values['judge-interval'], '--judge-interval', defaults.intervalS) * 1000,
    maxWaitMs: nonNegativeSeconds(values['max-wait'], '--max-wait', defaults.maxWaitS) * 1000,
  };
}

/** Progress marks: 'w' = waiting out a retry-after, '!' = gave up waiting (the rest go ungraded). */
function rateLimitProgress(stats: RateLimitStats): RunnerDeps['onRateLimited'] {
  return (who, _ms, info, gaveUp) => {
    recordRateLimit(stats, who, info, gaveUp);
    process.stdout.write(gaveUp ? '!' : 'w');
  };
}

function printRateLimits(stats: RateLimitStats): void {
  const lines = describeRateLimits(stats);
  if (lines.length > 0) console.log(`\n${lines.join('\n')}`);
}

// ------------------------------------------------------------------ rejudge

async function cmdRejudge(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      ...JUDGE_FLAGS,
      'judge-concurrency': { type: 'string' },
      'no-db': { type: 'boolean', default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const [ref] = positionals;
  if (!ref || positionals.length > 1) throw new Error('Usage: pnpm eval rejudge <results file>');
  const judgeOpts = judgeFlags(values, {
    settings: REJUDGE_SETTINGS,
    intervalS: REJUDGE_INTERVAL_S,
    maxWaitS: REJUDGE_MAX_WAIT_S,
  });
  const judgeConcurrency = positiveInt(values['judge-concurrency'], '--judge-concurrency', 1);
  const config = loadEvalConfig();
  if (!config.groqApiKey) throw new Error('GROQ_API_KEY is not set (.env, or the CI secret).');

  // A bare name is looked up in results/; a path is resolved from where the command was typed.
  const sourceFile = await resolveRunRef(
    RESULTS_DIR,
    ref.endsWith('.json') ? path.resolve(config.invocationDir, ref) : ref,
  );
  const source = await loadRun(sourceFile);
  const pending = source.cases.flatMap((c) => c.runs).filter((r) => isUngraded(r)).length;
  console.log(
    `${path.basename(sourceFile)}: ${String(pending)} of ${String(source.summary.runs)} runs ungraded (model ${source.meta.model}, prompt ${source.meta.promptVersion}).`,
  );
  if (pending === 0) {
    console.log('Nothing to re-grade.');
    return 0;
  }
  console.log(
    `Re-grading them from the saved lines with ${source.meta.judgeModel} at ${judgeSettingsKey(judgeOpts.settings)} (effort/max tokens), one call every ${String(judgeOpts.intervalMs / 1000)} s, waiting out retry-after up to ${String(judgeOpts.maxWaitMs / 1000)} s.`,
  );

  const { cases } = await readCases();
  const byId = new Map(cases.map((c) => [c.id, c]));
  const playbooks = parsePlaybooks(await readFile(PLAYBOOKS_FILE, 'utf8'));
  const needsDb = source.cases.some((c) => byId.get(c.id)?.window === null);
  const conn = needsDb && !values['no-db'] ? connectDb(config.databaseUrl) : null;
  try {
    const rateLimits = newRateLimitStats();
    let done = 0;
    const now = () => performance.now();
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const { run, info } = await rejudgeRun(
      { file: sourceFile, run: source },
      async (caseId) => {
        const c = byId.get(caseId);
        if (!c) return { ok: false, reason: 'no longer in dataset/cases.jsonl' };
        try {
          const r = await resolveCase(c, playbooks, conn ? dbLoader(conn.db) : null);
          return r.ok ? { ok: true, resolved: r.resolved } : { ok: false, reason: r.reason };
        } catch (err) {
          return {
            ok: false,
            reason: `database: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      },
      {
        judge: new GroqJudgeClient(source.meta.judgeModel, {
          apiKey: config.groqApiKey,
          baseUrl: config.groqBaseUrl,
          settings: judgeOpts.settings,
        }),
        gate: new JudgeGate(judgeConcurrency, judgeOpts.intervalMs, { now, sleep }),
        maxWaitMs: judgeOpts.maxWaitMs,
        onRateLimited: rateLimitProgress(rateLimits),
        createdAt: () => new Date().toISOString(),
        git: await gitInfo(REPO_ROOT),
        onGraded: (_id, r) => {
          done++;
          process.stdout.write(isUngraded(r) ? 'U' : r.pass ? '.' : 'F');
          if (done % 60 === 0 || done === pending)
            process.stdout.write(` ${String(done)}/${String(pending)}\n`);
        },
      },
    );
    run.meta.rateLimits = rateLimits;
    const file = await saveRun(RESULTS_DIR, run);
    console.log(`\n${formatRun(run, useColor(process.stdout.isTTY) ? COLOR : PLAIN)}`);
    printRateLimits(rateLimits);
    for (const s of info.skipped) console.log(`Skipped ${s.caseId}: ${s.reason}`);
    console.log(
      `\nRe-graded ${String(info.regraded)} of ${String(pending)}; ${String(info.stillUngraded)} still ungraded. Saved ${path.relative(process.cwd(), file)}`,
    );
    return reportProblems(
      runProblems(run.summary, { minPassRate: null, file: path.relative(process.cwd(), file) }),
    );
  } finally {
    await conn?.close();
  }
}

// ------------------------------------------------------------------ compare

async function cmdCompare(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { 'fail-on-regression': { type: 'boolean', default: false } },
    allowPositionals: true,
    strict: true,
  });
  const [refA = 'previous', refB = 'latest'] = positionals;
  const fileA = await resolveRunRef(RESULTS_DIR, refA);
  const fileB = await resolveRunRef(RESULTS_DIR, refB);
  const result = compareRuns(
    { file: fileA, run: await loadRun(fileA) },
    { file: fileB, run: await loadRun(fileB) },
  );
  console.log(formatCompare(result, useColor(process.stdout.isTTY) ? COLOR : PLAIN));
  return values['fail-on-regression'] && (result.regressions > 0 || result.overallRegressed)
    ? 1
    : 0;
}

// ------------------------------------------------------------------ candidates

async function cmdCandidates(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: { 'per-category': { type: 'string' } },
    strict: true,
  });
  const perCategory = positiveInt(values['per-category'], '--per-category', 10);
  const conn = connectDb(loadEvalConfig().databaseUrl);
  if (!conn) throw new Error('DATABASE_URL is not set: candidates are found in imported calls.');
  try {
    const refs = await listRecordingRefs(conn.db);
    const recordings: ScanRecording[] = [];
    for (const r of refs) {
      const rows = await getRecordingUtterances(conn.db, r.id);
      recordings.push({
        datasetId: r.datasetId,
        externalId: r.externalId,
        title: r.title,
        license: r.license,
        utterances: rows.map((u) => ({ idx: u.idx, speaker: u.speaker, text: u.text })),
      });
    }
    const found = findCandidates(recordings, { perCategory });
    await mkdir(CANDIDATES_DIR, { recursive: true });
    const jsonl = found.map((c) => JSON.stringify(candidateToCaseSkeleton(c))).join('\n');
    await writeFile(path.join(CANDIDATES_DIR, 'candidates.jsonl'), `${jsonl}\n`);
    // A readable review sheet. This folder is gitignored: it holds windows from
    // datasets without a license (real-sales), which must stay local.
    const md = [
      `# Candidate moments (${String(found.length)}), ${new Date().toISOString().slice(0, 10)}`,
      '',
      'Local only (gitignored). Copy the good ones from candidates.jsonl into dataset/cases.jsonl and write their rubrics.',
      '',
      ...found.flatMap((c, i) => [
        `## ${String(i + 1)}. ${c.category}: "${c.matched}"`,
        '',
        `${c.dataset} (${c.license}) · ${c.callId} · utterances ${String(c.utterances[0])}-${String(c.utterances[1])}`,
        '',
        ...c.window.map((l) => `> ${l}`),
        '',
      ]),
    ].join('\n');
    await writeFile(path.join(CANDIDATES_DIR, 'candidates.md'), md);
    const byCat = new Map<string, number>();
    for (const c of found) byCat.set(c.category, (byCat.get(c.category) ?? 0) + 1);
    console.log(`Scanned ${String(recordings.length)} calls; ${String(found.length)} candidates:`);
    for (const cat of CATEGORIES) console.log(`  ${cat.padEnd(22)} ${String(byCat.get(cat) ?? 0)}`);
    console.log(`Wrote ${path.relative(process.cwd(), CANDIDATES_DIR)}/candidates.{jsonl,md}`);
    return 0;
  } finally {
    await conn.close();
  }
}

// ------------------------------------------------------------------ cases

async function cmdCases(): Promise<number> {
  const { cases } = await readCases();
  const count = (key: (c: EvalCase) => string) => {
    const m = new Map<string, number>();
    for (const c of cases) m.set(key(c), (m.get(key(c)) ?? 0) + 1);
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  };
  console.log(`${String(cases.length)} valid cases in ${path.relative(process.cwd(), CASES_FILE)}`);
  for (const [title, key] of [
    ['By category', (c: EvalCase) => c.category],
    ['By dataset (license)', (c: EvalCase) => `${c.source.dataset} (${c.source.license})`],
    ['By status', (c: EvalCase) => c.status],
  ] as const) {
    console.log(`\n${title}`);
    for (const [k, n] of count(key)) console.log(`  ${k.padEnd(52)} ${String(n)}`);
  }
  const smoke = cases.filter((c) => c.smoke).length;
  const fromDb = cases.filter((c) => c.window === null).length;
  console.log(
    `\nSmoke subset: ${String(smoke)} · windows loaded from the local DB: ${String(fromDb)}`,
  );
  return 0;
}

// ------------------------------------------------------------------ main

async function main(): Promise<number> {
  // pnpm forwards a literal "--" when called as `pnpm eval -- --model x`.
  const argv = process.argv.slice(2).filter((a, i) => !(i === 0 && a === '--'));
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  loadRootEnvFile();
  const [first, ...rest] = argv;
  switch (first) {
    case 'rejudge':
      return cmdRejudge(rest);
    case 'compare':
      return cmdCompare(rest);
    case 'candidates':
      return cmdCandidates(rest);
    case 'cases':
      return cmdCases();
    case 'run':
      return cmdRun(rest);
    default:
      return cmdRun(argv);
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
