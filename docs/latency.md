# Suggestion latency: what we measure and what it means

Latency is Cue's core product metric. Every suggestion stores five timestamps in the `suggestions` table. **Never remove them.**

| Column               | Meaning                                                                 | Clock                                                    |
| -------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------- |
| `utterance_end_at`   | The prospect stopped speaking. **In replay, see the limitation below.** | realtime server                                          |
| `request_sent_at`    | The request to the model was sent.                                      | realtime server                                          |
| `first_token_at`     | The first token of the answer arrived.                                  | realtime server                                          |
| `last_token_at`      | The last token arrived, or we stopped at 20 words.                      | realtime server                                          |
| `client_rendered_at` | The suggestion was painted in the rep's browser.                        | server time plus a browser-measured duration (see below) |

`packages/db` → `toSuggestionTimings()` turns a row into the shared `SuggestionTimings` shape. `packages/evals` → `summarizeEndToEnd()` computes p50 and p95 from those.

## ⚠️ Limitation: replay has no speech-to-text

Replays play the dataset's **own transcript**. Nothing listens to audio, so nothing detects the end of speech. During replay:

- **`utterance_end_at` is when the replay emitted the prospect's final transcript line.** That's the moment a speech-to-text service _would_ deliver its final result. In a live call, `utterance_end` comes first and the final result arrives later.
- So **replay latency excludes the speech-to-text delay**: endpointing (waiting to be sure the speaker stopped) and the transcription itself. With a streaming speech-to-text service that's typically a few hundred milliseconds, set mostly by the endpointing setting. Real end-to-end latency will be **higher** than what replay shows.
- **What replay does measure:**
  - saving the final;
  - building the prompt;
  - the model's time to first token and to last token;
  - delivery to the browser and painting.

  In other words, everything Cue controls downstream of the transcript.

When a speech-to-text source is added (a future `SttSource`), `utterance_end_at` should come from the provider's end-of-speech signal instead. Then the gap between it and the final result becomes measurable too.

Other replay caveats:

- **Interims are simulated** (a few words at a time), not real speech-to-text partials.
- **Datasets without timestamps** (gwenshap, SaaS) use an estimated pace: about 160 words per minute, with 600 ms between turns. The gap before the rep "speaks" again is artificial. At 2× it's only 300 ms real time, so most suggestions there are cancelled because the rep started talking (see below).

## How `client_rendered_at` avoids clock skew

The browser and server clocks can disagree by tens or hundreds of milliseconds, so we never store a browser wall-clock time:

1. The server sends `suggestionCompleted` and records its own send time.
2. The browser measures, with `performance.now()` on its own clock, the time from receiving that message to the frame where the suggestion is painted (two animation frames after React commits). It reports that **duration** (`suggestionRendered{renderDelayMs}`).
3. The server stores `client_rendered_at = send time + renderDelayMs`.

**Caveat:** this leaves out network transit from server to browser. On localhost that's under a millisecond; on a real network it's typically 10 to 50 ms.

## Fast fallback: no suggestion rather than a late one

- **Only at 1× or 2×.** Instant-speed replays skip suggestions entirely.
- **At most one request in flight per session.** A newer prospect line cancels the previous request (`cancelled_newer`).
- **The rep starting to talk cancels it** (`cancelled_rep_spoke`). So do pause, seek, switching to instant, disconnecting and shutdown (`cancelled_stopped`).
- **Deadlines:**
  - No first token within **1.5 s** of the request: dropped (`first_token_timeout`). `SUGGESTION_FIRST_TOKEN_TIMEOUT_MS` sets this.
  - Not finished within **5 s**: dropped (`timeout`).
- **Provider errors:**
  - A **429**: dropped (`rate_limited`), and new suggestions are skipped until the provider's `retry-after` has passed.
  - Other errors: dropped (`api_error`). Nothing is retried.

A dropped suggestion is stored with `status = 'failed'` and its `failure_reason`, so p50 and p95 can be computed over completed suggestions while the drop rate is tracked separately. Report both: excluding drops makes latency look better than it is.

## Prompt caching

The prompt is ordered from most to least stable:

1. the static system prompt (`prompt_version`);
2. the playbook;
3. the last 12 utterances.

That way a provider's automatic prefix caching can reuse the leading tokens. As of 2026-11-17, Groq documents automatic prefix caching for its `openai/gpt-oss-*` models, which includes the default `openai/gpt-oss-20b`. Hits aren't guaranteed, and the cache expires after a while without use.

## The default model and reasoning settings

The default is `openai/gpt-oss-20b` (`GROQ_MODEL` changes it). The first choice, `llama-3.1-8b-instant`, returned `404 model_not_found` for our Groq account.

gpt-oss is a **reasoning model**: it writes hidden "thinking" tokens before the visible answer. That affects latency, because the first _visible_ token only arrives after the reasoning. It's sent with:

- `reasoning_effort: "low"`: less thinking, so the visible answer starts sooner.
- `include_reasoning: false`: the reasoning isn't streamed to us.
- `max_completion_tokens: 512`: with only 48, the reasoning used up the whole budget and no answer came back.

The visible line is still capped at 20 words, and generation stops as soon as it gets there.

A single check on 2026-11-17 returned a full answer in about 300 ms. That's one request, not a latency result.

## Measured numbers

Only record numbers measured against a **real** provider, with the date, model and sample size. Numbers from the mock model used in tests and local smoke checks (fixed delays) are not latency results.
