# @cue/evals: suggestion quality evals

An offline harness that measures how **good** Cue's suggested lines are, not just how fast they arrive. It replays real moments from imported calls through the exact prompt, client and settings production uses (`@cue/suggest`), then scores each line twice:

1. **Deterministic checks** (exact, free):
   - at most 20 words before production's cut;
   - one line;
   - no preamble ("Rep:", "Sure! Here's…");
   - no unfilled placeholders ("[Name]");
   - no banned phrases.
2. **An LLM judge**, a _different_ model from the one under test. It grades the line against the case's rubric on a 1–5 scale and gives a short rationale.

Each case runs N times, so you can see how much the results vary.

## Commands (PowerShell or bash)

```sh
pnpm eval                                   # all cases, 3 runs each, default model and prompt
pnpm eval --model openai/gpt-oss-20b --prompt-version suggest-v1
pnpm eval --smoke --runs 3                  # the judged smoke subset (manual CI workflow)
pnpm eval checks --smoke --runs 3           # deterministic checks only, no judge (CI on every PR)
pnpm eval --category price_objection --runs 5
pnpm eval rejudge latest                    # grade the ungraded lines of a saved run (no regeneration)
pnpm eval compare previous latest           # diff two saved runs, regressions first
pnpm eval candidates                        # propose new moments from your imported calls
pnpm eval cases                             # validate dataset/cases.jsonl and summarise it
pnpm eval --help
```

You need `GROQ_API_KEY` in `.env`. Cases from datasets without a license also need your local database with the calls imported (`docker compose up -d`, then `pnpm ingest -- --dataset real-sales`). Without them, those cases are skipped and listed as skipped.

**Judge settings are pinned** in `src/config.ts` (`JUDGE_PINNED`): low reasoning effort, a 512-token budget, one call every 12 s, and waits of up to 2 minutes for a retry-after. `pnpm eval`, `pnpm eval rejudge` and CI all use them, so verdicts from different runs are comparable. The `--judge-*` flags override them for an experiment, with a warning. Runs saved before 2026-11-19 were graded at medium/1024; compare those only with each other.

**How long it takes:** our Groq account allows the judge (`openai/gpt-oss-120b`) 8,000 tokens per minute and **200,000 tokens per day**, and Groq counts each call's whole 512-token budget against them. A judge call uses about 1,200 tokens, so a full run (43 cases × 3 runs, 129 calls) takes about 30 minutes and spends about 155,000 tokens (129 × a median 1,205): most of a day's quota. Plan one full run a day.

**Rate limits:**

- The harness waits out a rate limit for the full retry-after the provider asks for, and pauses every judge call meanwhile. This shows as `w` in the progress line.
- A wait longer than `--max-wait` (default 2 minutes) means a slow-refilling quota is spent, such as tokens per day. The remaining lines are then left **ungraded** straight away (`!`, then `U`), rather than each one sitting out the wait.
- After a run, the report says which limit was hit, from the provider's 429 message and `x-ratelimit-*` headers.

**Progress marks:**

| Mark | Meaning                               |
| ---- | ------------------------------------- |
| `.`  | pass                                  |
| `F`  | graded fail                           |
| `U`  | ungraded (the judge failed)           |
| `E`  | model error                           |
| `w`  | waiting out a rate limit              |
| `!`  | gave up waiting; the rest go ungraded |

## Deterministic checks only: `pnpm eval checks`

Generates lines exactly like `pnpm eval` (same prompt, model and settings) but scores them with the deterministic checks only: at most 20 words, one line, no preamble, no placeholders, no banned phrases. A model error fails the line.

- **No judge:** it spends none of the judge's daily token quota and can't be failed by a judge rate limit. That makes it safe to run on every pull request.
- **It is not a quality score.** It tells you the pipeline still produces lines a rep can say. Whether they're good needs the judge.
- **Nothing is saved to `results/`.** Pass `--json <file>` to keep the lines, and `--min-pass-rate` to set the exit code.

## Re-grading ungraded lines: `pnpm eval rejudge <run>`

When the judge failed on more than 5% of lines, `pnpm eval` exits non-zero and suggests:

```sh
pnpm eval rejudge results/20261119T001448Z_openai-gpt-oss-20b_suggest-v1.json
```

This grades only the ungraded lines, from the lines the model already wrote. Nothing is regenerated, so the lines, latency and cost stay exactly as measured. The result is written to a new `…_rejudged.json`, and the original is kept.

It uses the pinned judge settings, one call at a time, and waits out a retry-after of up to 15 minutes (it runs locally and can afford to).

Run it again later if it stopped at a daily limit.

**Things to know:**

- **Mixed judge settings.** Rejudging a run saved before the settings were pinned mixes them (its original lines were graded at medium/1024), which can shift verdicts. The report and `compare` list the mix, for example `medium/1024 ×51, low/512 ×78`.
- **Changed rubrics are skipped.** A case whose rubric, playbook or window changed since the run is skipped, so one run never mixes two rubrics.

## What a run reports

| Metric                | Meaning                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pass rate             | Share of **graded** lines that pass: every deterministic check, no "must not" violated, and a judge score ≥ 4. A model error counts as a failure (the rep would get nothing).                                                                           |
| Ungraded              | Lines the judge failed to grade (rate limit, timeout, unreadable verdict). Their outcome is unknown, so they're left out of the pass rate and mean score and counted under Errors. More than 5% ungraded makes `pnpm eval` exit non-zero.               |
| Mean score            | Mean judge score (1–5) over graded lines. An empty line scores 1.                                                                                                                                                                                       |
| Score spread          | Mean per-case standard deviation of the score across its N runs. A **flaky** case passed in some runs and failed in others.                                                                                                                             |
| First token p50 / p95 | Time from request sent to the first visible token, measured by the harness against the real provider. Runs over production's 1.5 s deadline are counted. Excludes speech-to-text and the browser.                                                       |
| Cost per 1,000        | For the model under test: real token counts (hidden reasoning included) × the prices in `src/pricing.ts`, with their source and date. A model with no listed price reports "unknown". Cached-input discounts aren't applied, so this is an upper bound. |

Every run is saved to `results/<time>_<model>_<prompt-version>.json`. It records:

- the git commit (and whether the tree had uncommitted changes);
- the prompt version, judge model and judge version;
- a hash of the case file and of each case's rubric;
- every generated line with its checks, verdict, latency and token counts.

`results/` is gitignored, because it holds model output generated from datasets that can't be redistributed. CI uploads its run as an artifact instead.

**Comparing runs:** `compare` flags a case as regressed when:

- its pass rate drops by ≥ 0.25 (one run of 3, or 1 of 4), or
- its mean score drops by ≥ 0.5.

A case whose rubric changed is shown as "rubric changed" and never counted as a regression. Changed settings (model, prompt, judge, N, case file) are listed at the top. With small N, one flipped run moves a case a lot, so look at the flaky column before trusting a single regression. Use `--fail-on-regression` to make it exit non-zero.

## The dataset: `dataset/cases.jsonl`

One case per line: a moment where the **prospect just spoke**, the conversation up to that line (at most 12 utterances, like production), the playbook to use, and a rubric. Lines starting with `//` are comments. `pnpm eval cases` validates every edit and reports problems with line numbers.

```jsonc
{
  "id": "price-saas-34-cheaper-options",
  "status": "DRAFT", // DRAFT until a person has reviewed the rubric, then REVIEWED
  "category": "price_objection", // price_objection | send_email | stakeholder_approval | competitor | disengaged | buying_signal | vague_pain
  "smoke": true, // part of the CI subset (needs an inline window)
  "source": {
    "dataset": "DeepMostInnovations/saas-sales-conversations",
    "license": "apache-2.0",
    "callId": "saas-7-conv-34", // the dataset's own id (recordings.external_id)
    "utterances": [0, 10], // inclusive range; the last one is the prospect's line
  },
  "playbook": "testmaster", // a key in dataset/playbooks.json, or "none"
  "window": ["Rep: …", "Prospect: …"], // null = loaded from your local DB (see Licenses)
  "rubric": {
    "must": ["Acknowledges that $5,000 a month is a big step for them", "…"],
    "mustNot": ["Invents a cheaper plan, tier or discount"], // on top of the standard ones
    "bannedPhrases": [], // exact phrases that fail the line
  },
  "notes": "",
}
```

**Every rubric is checked against these standard "must not" rules, on top of its own:**

- inventing features, prices, numbers, customers or facts;
- arguing with or contradicting the prospect;
- anything a rep couldn't say out loud on a live call.

**There is no ground-truth "best line" in these datasets,** so rubrics are written by a person. All 43 current rubrics are **DRAFT**: written by Claude from the candidate moments, for you to review. Change a case to `REVIEWED` once you agree with it.

**Playbooks** (`dataset/playbooks.json`, also DRAFT) are built only from facts stated in each dataset's own calls: TestMaster's $5,000 a month, its CI/CD integration, and so on. That way "invents features" can be judged against something concrete.

**Adding cases:**

1. `pnpm eval candidates` scans your imported calls for prospect lines with objection, email, approval, competitor, disengaged, buying-signal and vague-pain language. It takes the 12 utterances ending at that line as the window.
2. It writes `candidates/candidates.md`, a readable review sheet, and `candidates/candidates.jsonl`, with one ready-to-edit case skeleton per moment. Both are gitignored, because they can contain windows from unlicensed datasets.
3. Copy the good ones into `dataset/cases.jsonl` and write their rubrics.

## Licenses

Per-case license information is kept in each case's `source.license`. Current cases:

| Dataset                                                                                                                      | License     | Cases | How the text is stored                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------- | ----- | ------------------------------------------------------------------------------------------------------- |
| [gwenshap/sales-transcripts](https://huggingface.co/datasets/gwenshap/sales-transcripts)                                     | Apache-2.0  | 19    | Excerpts (≤ 12 utterances) inline in `cases.jsonl`                                                      |
| [DeepMostInnovations/saas-sales-conversations](https://huggingface.co/datasets/DeepMostInnovations/saas-sales-conversations) | Apache-2.0  | 17    | Excerpts (≤ 12 utterances) inline in `cases.jsonl`                                                      |
| [liva-ai/real-sales](https://huggingface.co/datasets/liva-ai/real-sales)                                                     | none stated | 7     | **Not stored.** Only call id + utterance range; the text is loaded from your local database at run time |

**The Apache-2.0 excerpts** are redistributed under that license. They're unmodified except for being cut to the window, and the rubrics and playbooks are our own additions.

**liva-ai/real-sales has no stated license,** so none of its text is copied into this repository: not windows, not matched phrases. The case schema refuses an inline window for a dataset whose license is `unspecified`. Its eval results stay in the gitignored `results/` folder. See [docs/datasets.md](../../docs/datasets.md).

## CI

Both workflows use the smoke subset: 8 inline cases × 3 runs, Apache-2.0 only, so no database is needed. Both need the repository secret `GROQ_API_KEY`. Each writes its report to the job summary and uploads its output as an artifact.

| Workflow          | When                                 | What it runs                                        | Fails when                                                                      |
| ----------------- | ------------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------- |
| `eval-checks.yml` | every pull request                   | `pnpm eval checks --smoke`: deterministic, no judge | fewer than `EVAL_MIN_CHECKS_PASS_RATE` (default 0.30) of lines pass every check |
| `eval-smoke.yml`  | manual only (Actions → Run workflow) | `pnpm eval --smoke` with the judge at low/512       | pass rate below `EVAL_MIN_PASS_RATE` (default 0.04), or more than 5% ungraded   |

**Why the judge doesn't run on every PR:** the judge's daily token limit (200,000 on our Groq account) is shared with local runs on the same key, and Groq counts each call's whole max-token budget against it. A judged job on every PR would spend that quota and fail at random with 429s.

Pull requests from forks don't get secrets, so for them the checks are skipped with a warning.

## Changing the prompt or the judge

- **The suggestion prompt** lives in `packages/suggest/src/prompt.ts`. To change it, add a new entry to `SYSTEM_PROMPTS` with a new version, keep the old one, then compare the two:

  ```sh
  pnpm eval --prompt-version suggest-v1
  pnpm eval --prompt-version suggest-v2
  pnpm eval compare previous latest
  ```

- **The judge prompt** is `JUDGE_SYSTEM_PROMPT` in `src/judge.ts`. Changing it means bumping `JUDGE_VERSION`: scores from different judge versions aren't comparable, and `compare` says so.
- **The default judge** is `openai/gpt-oss-120b`: a larger, different model from the default under test, and production-tier on Groq. It's from the same model family, which can bias it toward its sibling's style. To use another judge, pass `--judge-model` or set `EVAL_JUDGE_MODEL`. The harness refuses a judge that is the same model as the one under test.
