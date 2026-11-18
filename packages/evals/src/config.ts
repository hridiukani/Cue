import { z } from 'zod';

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
