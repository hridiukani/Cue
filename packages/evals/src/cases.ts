import { createHash } from 'node:crypto';
import type { WindowUtterance } from '@cue/suggest';
import { z } from 'zod';

/**
 * One eval case = one moment in a call where the prospect just spoke, plus a
 * rubric for the rep's next line. Stored one per line in dataset/cases.jsonl.
 *
 * There is no ground-truth "best line" in these datasets, so the rubric is
 * written by a person. Cases start as status "DRAFT" until reviewed.
 */

export const CATEGORIES = [
  'price_objection',
  'send_email',
  'stakeholder_approval',
  'competitor',
  'disengaged',
  'buying_signal',
  'vague_pain',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** "Rep: …" / "Prospect: …": easy to read and edit in the JSONL file. */
const LINE = /^(Rep|Prospect):\s+(\S.*)$/;

const WindowLineSchema = z
  .string()
  .regex(LINE, 'each window line must start with "Rep: " or "Prospect: "')
  .transform((line): WindowUtterance => {
    const m = LINE.exec(line);
    if (!m) throw new Error('unreachable');
    return { speaker: m[1] === 'Rep' ? 'rep' : 'prospect', text: m[2] ?? '' };
  });

const nonEmpty = z.string().trim().min(1);

export const EvalCaseSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/, 'lowercase letters, digits and dashes'),
    status: z.enum(['DRAFT', 'REVIEWED']),
    category: z.enum(CATEGORIES),
    /** Part of the small subset CI runs on every PR. Must have an inline window. */
    smoke: z.boolean().default(false),
    source: z
      .object({
        dataset: nonEmpty,
        /** The dataset's license as imported (e.g. "apache-2.0", "unspecified"). */
        license: nonEmpty,
        /** The dataset's own id for the call (recordings.external_id): stable across machines. */
        callId: nonEmpty,
        /** Inclusive utterance indexes [first, last] of the window; the last is the prospect's line. */
        utterances: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
      })
      .strict()
      .refine((s) => s.utterances[0] <= s.utterances[1], 'utterances must be [first, last]'),
    /** A key in dataset/playbooks.json, or "none" for the generic prompt. */
    playbook: nonEmpty,
    /**
     * The conversation, oldest first, ending with the prospect's line. null =
     * loaded from the local database at run time (datasets without a license,
     * like liva-ai/real-sales, must not be copied into the repo).
     */
    window: z.array(WindowLineSchema).min(1).max(12).nullable(),
    rubric: z
      .object({
        /** What a good line must do. */
        must: z.array(nonEmpty).min(1).max(6),
        /** Case-specific things it must not do (the standard ones apply to every case). */
        mustNot: z.array(nonEmpty).max(6).default([]),
        /** Exact phrases that fail the line (case-insensitive). */
        bannedPhrases: z.array(nonEmpty).max(10).default([]),
      })
      .strict(),
    notes: z.string().default(''),
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.window) {
      if (c.window.at(-1)?.speaker !== 'prospect') {
        ctx.addIssue({
          code: 'custom',
          path: ['window'],
          message: 'the last line must be the prospect',
        });
      }
      const span = c.source.utterances[1] - c.source.utterances[0] + 1;
      if (span !== c.window.length) {
        ctx.addIssue({
          code: 'custom',
          path: ['window'],
          message: `window has ${String(c.window.length)} lines but source.utterances spans ${String(span)}`,
        });
      }
    }
    if (c.smoke && !c.window) {
      ctx.addIssue({
        code: 'custom',
        path: ['smoke'],
        message: 'smoke cases need an inline window (CI has no database)',
      });
    }
    if (c.window && c.source.license === 'unspecified') {
      ctx.addIssue({
        code: 'custom',
        path: ['window'],
        message: 'datasets without a license must not be copied in: set window to null',
      });
    }
  });

export type EvalCase = z.infer<typeof EvalCaseSchema>;

export class CaseFileError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid eval cases:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'CaseFileError';
  }
}

/**
 * Parse a JSONL file of cases. Blank lines and lines starting with // are
 * ignored. Every problem is reported with its line number, all at once.
 */
export function parseCases(text: string): EvalCase[] {
  const cases: EvalCase[] = [];
  const problems: string[] = [];
  const seen = new Map<string, number>();
  text.split(/\r?\n/).forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (line === '' || line.startsWith('//')) return;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      problems.push(`line ${String(lineNo)}: not valid JSON`);
      return;
    }
    const parsed = EvalCaseSchema.safeParse(json);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const where = issue.path.length > 0 ? ` ${issue.path.join('.')}` : '';
        problems.push(`line ${String(lineNo)}${where}: ${issue.message}`);
      }
      return;
    }
    const first = seen.get(parsed.data.id);
    if (first !== undefined) {
      problems.push(
        `line ${String(lineNo)}: duplicate id "${parsed.data.id}" (first on line ${String(first)})`,
      );
      return;
    }
    seen.set(parsed.data.id, lineNo);
    cases.push(parsed.data);
  });
  if (problems.length > 0) throw new CaseFileError(problems);
  return cases;
}

/**
 * Fingerprint of what a case asks for (rubric + playbook + window source).
 * Compare uses it: a case whose rubric changed between two runs can't be
 * compared fairly, and is reported as such instead of as a regression.
 */
export function rubricHash(c: EvalCase): string {
  const material = JSON.stringify({
    rubric: c.rubric,
    playbook: c.playbook,
    source: c.source,
    window: c.window,
  });
  return createHash('sha256').update(material).digest('hex').slice(0, 16);
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
