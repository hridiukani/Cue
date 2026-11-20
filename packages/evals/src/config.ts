import { z } from 'zod';
import type { JudgeSettings } from './judge';

// An empty value (e.g. 'GROQ_API_KEY=' copied from .env.example) means "not set".
const optional = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim()));

const EnvSchema = z.object({
  GROQ_API_KEY: optional,
  GROQ_BASE_URL: z.url().default('https://api.groq.com/openai/v1'),
  /** The model under test when --model isn't given: the same default as production. */
  GROQ_MODEL: z.string().min(1).default('openai/gpt-oss-20b'),
  /** The judge. Must differ from the model under test. */
  EVAL_JUDGE_MODEL: z.string().min(1).default('openai/gpt-oss-120b'),
  /** Only needed for cases whose window lives in the local database, and for `candidates`. */
  DATABASE_URL: optional,
  /** Set by pnpm to the folder the command was typed in (scripts run inside the package). */
  INIT_CWD: optional,
});

/**
 * The judge settings every graded run uses (`pnpm eval`, `pnpm eval rejudge`,
 * CI), pinned here so verdicts stay comparable across runs. Pinned 2026-11-20.
 * Results files record the settings per line, and compare flags a change or a mix.
 *
 * - low effort, 512 tokens: Groq admits a call against its tokens-per-day limit
 *   (200,000 for openai/gpt-oss-120b) by prompt + the FULL completion budget,
 *   so 512 instead of 1,024 fits more calls a day. A low-effort reply used at
 *   most 386 completion tokens in 164 graded lines (median call 1,205 tokens
 *   in total, 2026-11-19/20).
 * - one call every 12 s: 5 a minute × a median 1,205 tokens ≈ 6,000, under
 *   the 8,000 tokens-per-minute limit (an unusually long minute is waited out).
 * - wait out a retry-after of up to 120 s (a tokens-per-minute wait); a longer
 *   one means the daily quota is spent, so the rest are left ungraded at once.
 *
 * Caveat: runs before 2026-11-19 were graded at medium/1024
 * (LEGACY_JUDGE_SETTINGS). Low effort may grade more leniently, so compare
 * runs graded with the same settings.
 * Changing these is like changing the judge prompt: re-grade the baselines.
 */
export const JUDGE_PINNED: {
  readonly settings: JudgeSettings;
  readonly intervalS: number;
  readonly maxWaitS: number;
} = {
  settings: { reasoningEffort: 'low', maxCompletionTokens: 512 },
  intervalS: 12,
  maxWaitS: 120,
};

export interface EvalConfig {
  groqApiKey: string | undefined;
  groqBaseUrl: string;
  defaultModel: string;
  judgeModel: string;
  databaseUrl: string | undefined;
  /** Where relative output paths (--json, --markdown) resolve from: where `pnpm eval` was typed. */
  invocationDir: string;
}

/** The only place @cue/evals reads env. */
export function loadEvalConfig(env: Record<string, string | undefined> = process.env): EvalConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid @cue/evals env:\n${z.prettifyError(parsed.error)}`);
  }
  const e = parsed.data;
  return {
    groqApiKey: e.GROQ_API_KEY,
    groqBaseUrl: e.GROQ_BASE_URL,
    defaultModel: e.GROQ_MODEL,
    judgeModel: e.EVAL_JUDGE_MODEL,
    databaseUrl: e.DATABASE_URL,
    invocationDir: e.INIT_CWD ?? process.cwd(),
  };
}

/** Colour in the terminal only for a real TTY, and never when NO_COLOR is set. */
export function useColor(isTty: boolean, env: Record<string, string | undefined> = process.env) {
  return isTty && (env.NO_COLOR ?? '') === '';
}
