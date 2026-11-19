import type { CompareResult } from './compare';
import type { RunFile } from './results';
import { UNGRADED_MAX_SHARE } from './summary';

/** Plain-text tables for the terminal. ANSI colour only when asked (a TTY without NO_COLOR). */

export interface Style {
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  bold: (s: string) => string;
  dim: (s: string) => string;
}

const ansi = (code: number) => (s: string) => `\u001b[${String(code)}m${s}\u001b[0m`;
export const COLOR: Style = {
  red: ansi(31),
  green: ansi(32),
  yellow: ansi(33),
  bold: ansi(1),
  dim: ansi(2),
};
const id = (s: string) => s;
export const PLAIN: Style = { red: id, green: id, yellow: id, bold: id, dim: id };

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;
const visible = (s: string) => s.replace(ANSI, '').length;

/** Left-aligned columns; numbers are right-aligned when `right` says so. */
export function table(rows: string[][], right: readonly number[] = []): string {
  const widths: number[] = [];
  for (const r of rows)
    r.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, visible(cell))));
  return rows
    .map((r) =>
      r
        .map((cell, i) => {
          const pad = ' '.repeat((widths[i] ?? 0) - visible(cell));
          return right.includes(i) ? pad + cell : cell + pad;
        })
        .join('  ')
        .trimEnd(),
    )
    .join('\n');
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const pctOrNone = (x: number | null) => (x === null ? 'n/a' : pct(x));
const num = (x: number | null, digits = 2) => (x === null ? '–' : x.toFixed(digits));
const ms = (x: number | null) => (x === null ? '–' : `${String(Math.round(x))} ms`);
const usd = (x: number | null) =>
  x === null ? 'unknown' : `$${x < 0.01 ? x.toFixed(5) : x < 1 ? x.toFixed(4) : x.toFixed(2)}`;

export function formatRun(run: RunFile, style: Style = PLAIN): string {
  const { meta, summary: s } = run;
  const commit = meta.git.commit
    ? meta.git.commit.slice(0, 7) + (meta.git.dirty ? '+dirty' : '')
    : 'no git';
  const lines: string[] = [];
  lines.push(style.bold(`Eval run ${meta.createdAt}`));
  lines.push(
    `model ${meta.model} · prompt ${meta.promptVersion} · judge ${meta.judgeModel} (${meta.judgeVersion}) · N=${String(meta.runsPerCase)} · ${commit}`,
  );
  if (meta.skipped.length > 0) {
    lines.push(style.yellow(`Skipped ${String(meta.skipped.length)} case(s):`));
    for (const sk of meta.skipped) lines.push(style.yellow(`  ${sk.caseId}: ${sk.reason}`));
  }
  const ungradedCount = `${String(s.ungraded)} of ${String(s.runs)} runs (${pct(s.ungradedShare)})`;
  const ungradedText = `Ungraded: ${ungradedCount}`;
  if (s.ungraded > 0) {
    lines.push('');
    const over = s.ungradedShare > UNGRADED_MAX_SHARE;
    const say = over ? (t: string) => style.red(style.bold(t)) : style.yellow;
    lines.push(
      say(
        `${ungradedText}: the judge failed on them, so their outcome is unknown. They are excluded from the pass rate and mean score${over ? `, and more than ${pct(UNGRADED_MAX_SHARE)} ungraded makes this run untrustworthy. Grade them with: pnpm eval rejudge <this file>` : '.'}`,
      ),
    );
  }
  lines.push('');
  const pr = s.passRate ?? 0;
  const passColor = pr >= 0.8 ? style.green : pr >= 0.6 ? style.yellow : style.red;
  lines.push(
    table([
      ['Metric', 'Value'],
      ['Cases / runs', `${String(s.cases)} / ${String(s.runs)}`],
      [
        'Pass rate',
        passColor(`${pctOrNone(s.passRate)} (${String(s.passes)}/${String(s.graded)} graded runs)`),
      ],
      ['Ungraded', s.ungraded > 0 ? style.red(ungradedCount) : '0'],
      ['Mean score', `${num(s.meanScore)} / 5 (graded runs)`],
      [
        'Score spread',
        `σ ${num(s.meanCaseScoreStdDev)} per case · ${String(s.flakyCases)} flaky case(s)`,
      ],
      [
        'First token p50 / p95',
        s.firstTokenMs
          ? `${ms(s.firstTokenMs.p50)} / ${ms(s.firstTokenMs.p95)} (${String(s.firstTokenMs.count)} samples · ${String(s.overDeadline)} over 1.5 s)`
          : '–',
      ],
      [
        'Cost per 1,000',
        `${usd(s.costPer1000Usd)} (model under test, ${String(s.costedRuns)} costed runs) · judge this run: ${usd(s.judgeCostUsd)}`,
      ],
      [
        'Errors',
        s.errors > 0
          ? style.red(
              `${String(s.errors)} (model ${String(s.modelErrors)} · ungraded ${String(s.ungraded)})`,
            )
          : '0',
      ],
    ]),
  );
  lines.push('');
  lines.push(style.bold('By category'));
  lines.push(
    table(
      [
        ['Category', 'Pass rate', 'Graded', 'Ungraded'],
        ...Object.entries(s.byCategory)
          .sort(([x], [y]) => x.localeCompare(y))
          .map(([cat, v]) => [
            cat,
            pctOrNone(v.passRate),
            `${String(v.graded)}/${String(v.runs)}`,
            String(v.ungraded),
          ]),
      ],
      [1, 2, 3],
    ),
  );
  lines.push('');
  lines.push(style.bold('Cases'));
  lines.push(
    table(
      [
        ['Case', 'Category', 'Pass', 'Mean', 'σ', 'Most common failure'],
        ...run.cases.map((c) => {
          const reasons = c.runs.flatMap((r) => r.reasons);
          const top = mostCommon(reasons);
          const pass = `${String(c.summary.passes)}/${String(c.summary.graded)}${c.summary.ungraded > 0 ? ` (+${String(c.summary.ungraded)}?)` : ''}`;
          return [
            c.id,
            c.category,
            c.summary.graded === 0
              ? style.dim(pass)
              : c.summary.passes === c.summary.graded
                ? style.green(pass)
                : c.summary.passes === 0
                  ? style.red(pass)
                  : style.yellow(pass),
            num(c.summary.meanScore, 1),
            num(c.summary.scoreStdDev, 1),
            top ? style.dim(top.slice(0, 70)) : '',
          ];
        }),
      ],
      [2, 3, 4],
    ),
  );
  lines.push('');
  lines.push(
    style.dim(
      'Latency is measured by this harness against the real provider (request sent → first visible token); it excludes speech-to-text and the browser.',
    ),
  );
  return lines.join('\n');
}

function mostCommon(xs: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of counts) {
    if (v > n) {
      best = k;
      n = v;
    }
  }
  return best;
}

const signed = (x: number | null, fmt: (v: number) => string) =>
  x === null ? '–' : `${x > 0 ? '+' : x < 0 ? '−' : '±'}${fmt(Math.abs(x))}`;

export function formatCompare(r: CompareResult, style: Style = PLAIN): string {
  const lines: string[] = [];
  lines.push(style.bold('Compare eval runs'));
  lines.push(`A ${r.a.meta.createdAt} · ${r.a.meta.model} · ${r.a.meta.promptVersion}`);
  lines.push(`B ${r.b.meta.createdAt} · ${r.b.meta.model} · ${r.b.meta.promptVersion}`);
  if (r.settingsChanged.length > 0) {
    lines.push(style.yellow(`Settings changed: ${r.settingsChanged.join('; ')}`));
  }
  if (r.sameSettings) {
    lines.push(
      style.yellow(
        `Same model, prompt, judge, N and cases: every difference below is run-to-run noise. With N=${String(r.a.meta.runsPerCase)}, one flipped run moves a case by ${String(Math.round(100 / r.a.meta.runsPerCase))} points; use --runs 5 or more before trusting a regression.`,
      ),
    );
  }
  lines.push('');
  const m = r.metrics;
  // For pass rate and score, up is good; for latency and cost, down is good.
  const tone = (delta: number | null, upIsGood: boolean, text: string) =>
    delta === null || Math.abs(delta) < 1e-9
      ? text
      : delta > 0 === upIsGood
        ? style.green(text)
        : style.red(text);
  lines.push(
    table(
      [
        ['Metric', 'A', 'B', 'Change'],
        [
          'Pass rate',
          m.passRate.a === null ? '–' : pct(m.passRate.a),
          m.passRate.b === null ? '–' : pct(m.passRate.b),
          tone(
            m.passRate.delta,
            true,
            signed(m.passRate.delta, (v) => `${(v * 100).toFixed(1)} pts`),
          ),
        ],
        [
          'Mean score',
          num(m.meanScore.a),
          num(m.meanScore.b),
          tone(
            m.meanScore.delta,
            true,
            signed(m.meanScore.delta, (v) => v.toFixed(2)),
          ),
        ],
        [
          'First token p50',
          ms(m.firstTokenP50.a),
          ms(m.firstTokenP50.b),
          tone(
            m.firstTokenP50.delta,
            false,
            signed(m.firstTokenP50.delta, (v) => `${String(Math.round(v))} ms`),
          ),
        ],
        [
          'First token p95',
          ms(m.firstTokenP95.a),
          ms(m.firstTokenP95.b),
          tone(
            m.firstTokenP95.delta,
            false,
            signed(m.firstTokenP95.delta, (v) => `${String(Math.round(v))} ms`),
          ),
        ],
        [
          'Cost per 1,000',
          usd(m.costPer1000Usd.a),
          usd(m.costPer1000Usd.b),
          tone(
            m.costPer1000Usd.delta,
            false,
            signed(m.costPer1000Usd.delta, (v) => `$${v.toFixed(4)}`),
          ),
        ],
      ],
      [1, 2, 3],
    ),
  );
  lines.push('');
  const changed = r.cases.filter((c) => c.status !== 'unchanged');
  if (changed.length === 0) {
    lines.push('No case changed beyond the thresholds.');
  } else {
    const label: Record<string, string> = {
      regressed: style.red('REGRESSED'),
      improved: style.green('improved'),
      rubric_changed: style.yellow('rubric changed (not compared)'),
      errored: style.yellow('had errors (not compared)'),
      only_in_a: style.dim('only in A'),
      only_in_b: style.dim('only in B'),
      unchanged: '',
    };
    const order = ['regressed', 'rubric_changed', 'errored', 'improved', 'only_in_a', 'only_in_b'];
    lines.push(
      table([
        ['Case', 'Category', 'Pass A → B', 'Score A → B', 'Status'],
        ...changed
          .sort(
            (x, y) => order.indexOf(x.status) - order.indexOf(y.status) || x.id.localeCompare(y.id),
          )
          .map((c) => [
            c.id,
            c.category,
            `${c.a ? pctOrNone(c.a.passRate) : '–'} → ${c.b ? pctOrNone(c.b.passRate) : '–'}`,
            `${num(c.a?.meanScore ?? null, 1)} → ${num(c.b?.meanScore ?? null, 1)}`,
            label[c.status] ?? c.status,
          ]),
      ]),
    );
  }
  lines.push('');
  const verdict = `${String(r.regressions)} regression(s), ${String(r.improvements)} improvement(s)${r.overallRegressed ? ' · overall pass rate regressed' : ''}`;
  lines.push(
    r.regressions > 0 || r.overallRegressed ? style.red(style.bold(verdict)) : style.green(verdict),
  );
  return lines.join('\n');
}
