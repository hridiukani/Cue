import { z } from 'zod';

/**
 * WebSocket protocol between the browser (apps/web) and apps/realtime.
 * Every message is JSON with a `type`. Both sides validate with these schemas.
 *
 * Connection flow: client sends `hello` (with a ticket) → server `ready` →
 * client `start` (new replay) or `resume` (after a reconnect) → server
 * `session` (+ `snapshot` on resume) → stream of `state` / `interim` / `final`.
 */

export const PROTOCOL_VERSION = 1;
export const MAX_CLIENT_MESSAGE_BYTES = 16 * 1024;

export const SpeakerSchema = z.enum(['rep', 'prospect']);
export type Speaker = z.infer<typeof SpeakerSchema>;

export const SpeedSchema = z.enum(['1x', '2x', 'instant']);
export type Speed = z.infer<typeof SpeedSchema>;

const ms = z.number().int().nonnegative();
const id = z.uuid();

/** Feedback a rep can give on a suggestion from the call screen. */
export const FeedbackSignalSchema = z.enum(['thumbs_up', 'thumbs_down', 'used']);
export type FeedbackSignal = z.infer<typeof FeedbackSignalSchema>;

/** Why a suggestion was dropped (stored in suggestions.failure_reason). */
export const SuggestionFailureReasonSchema = z.enum([
  'cancelled_newer', // a newer prospect utterance arrived
  'cancelled_rep_spoke', // the rep started talking over it
  'cancelled_stopped', // pause, seek, speed change to instant, disconnect or shutdown
  'first_token_timeout', // no first token within the deadline (1.5 s): late is worse than none
  'timeout', // the whole suggestion took too long
  'rate_limited', // provider returned 429
  'api_error', // other provider or network error
  'empty_output', // the model returned nothing usable
]);
export type SuggestionFailureReason = z.infer<typeof SuggestionFailureReasonSchema>;

// ---------------------------------------------------------------- client → server

const Hello = z
  .object({
    type: z.literal('hello'),
    v: z.literal(PROTOCOL_VERSION),
    ticket: z.string().min(1).max(2048),
  })
  .strict();
const Start = z
  .object({
    type: z.literal('start'),
    recordingId: id,
    speed: SpeedSchema,
    positionMs: ms.optional(),
    // One of the user's playbooks; suggestions use a generic prompt without one.
    playbookId: id.optional(),
  })
  .strict();
const Resume = z.object({ type: z.literal('resume'), sessionId: id }).strict();
const Play = z.object({ type: z.literal('play') }).strict();
const Pause = z.object({ type: z.literal('pause') }).strict();
const Seek = z.object({ type: z.literal('seek'), positionMs: ms }).strict();
const SetSpeed = z.object({ type: z.literal('setSpeed'), speed: SpeedSchema }).strict();
const Ping = z.object({ type: z.literal('ping') }).strict();
/**
 * The browser painted a completed suggestion. It reports a DURATION on its own
 * clock (message received → painted), never a wall-clock time, so browser/server
 * clock skew can't corrupt the stored timestamps.
 */
const SuggestionRendered = z
  .object({
    type: z.literal('suggestionRendered'),
    suggestionId: id,
    renderDelayMs: z.number().int().min(0).max(60_000),
  })
  .strict();
const Feedback = z
  .object({ type: z.literal('feedback'), suggestionId: id, signal: FeedbackSignalSchema })
  .strict();

export const ClientMessageSchema = z.discriminatedUnion('type', [
  Hello,
  Start,
  Resume,
  Play,
  Pause,
  Seek,
  SetSpeed,
  Ping,
  SuggestionRendered,
  Feedback,
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---------------------------------------------------------------- server → client

export const FinalUtteranceSchema = z
  .object({
    utteranceId: id,
    speaker: SpeakerSchema,
    key: z.string().min(1),
    text: z.string(),
    startMs: ms,
    endMs: ms,
  })
  .strict();
export type FinalUtterance = z.infer<typeof FinalUtteranceSchema>;

export const SessionStateSchema = z.enum(['playing', 'paused', 'ended', 'failed']);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const StatusCodeSchema = z.enum([
  'client_slow',
  'persist_failed',
  'session_resumed',
  'source_error',
]);
export const ErrorCodeSchema = z.enum([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_state',
  'internal',
]);

/** Every server message carries a per-connection sequence number and the server's clock. */
const envelope = { seq: z.number().int().nonnegative(), serverTs: z.number().int().nonnegative() };

const Ready = z
  .object({ type: z.literal('ready'), v: z.literal(PROTOCOL_VERSION), ...envelope })
  .strict();
const Session = z
  .object({
    type: z.literal('session'),
    sessionId: id,
    recordingId: id,
    title: z.string(),
    durationMs: ms,
    timing: z.enum(['real', 'estimated']),
    capabilities: z.object({ seek: z.boolean(), speeds: z.array(SpeedSchema) }).strict(),
    // Whether this session generates suggestions (needs an LLM API key), and with what.
    suggestions: z
      .object({
        available: z.boolean(),
        model: z.string().nullable(),
        playbook: z.string().nullable(),
      })
      .strict(),
    ...envelope,
  })
  .strict();
const Snapshot = z
  .object({ type: z.literal('snapshot'), utterances: z.array(FinalUtteranceSchema), ...envelope })
  .strict();
const State = z
  .object({
    type: z.literal('state'),
    state: SessionStateSchema,
    positionMs: ms,
    speed: SpeedSchema,
    ...envelope,
  })
  .strict();
const Interim = z
  .object({
    type: z.literal('interim'),
    speaker: SpeakerSchema,
    key: z.string().min(1),
    text: z.string(),
    startMs: ms,
    endMs: ms,
    ...envelope,
  })
  .strict();
const Final = FinalUtteranceSchema.extend({ type: z.literal('final'), ...envelope }).strict();
const Status = z
  .object({
    type: z.literal('status'),
    level: z.enum(['info', 'warning', 'error']),
    code: StatusCodeSchema,
    message: z.string(),
    retryable: z.boolean(),
    ...envelope,
  })
  .strict();
const ErrorMessage = z
  .object({ type: z.literal('error'), code: ErrorCodeSchema, message: z.string(), ...envelope })
  .strict();
const Pong = z.object({ type: z.literal('pong'), ...envelope }).strict();

// Suggestions: started → (token)* → completed | dropped
const SuggestionStarted = z
  .object({ type: z.literal('suggestionStarted'), suggestionId: id, utteranceId: id, ...envelope })
  .strict();
/** The suggestion text so far (cleaned up), not a delta, so the client just replaces it. */
const SuggestionToken = z
  .object({ type: z.literal('suggestionToken'), suggestionId: id, text: z.string(), ...envelope })
  .strict();
const SuggestionCompleted = z
  .object({
    type: z.literal('suggestionCompleted'),
    suggestionId: id,
    text: z.string(),
    // Server-measured latency from utterance_end (see docs/latency.md).
    firstTokenMs: ms,
    lastTokenMs: ms,
    ...envelope,
  })
  .strict();
const SuggestionDropped = z
  .object({
    type: z.literal('suggestionDropped'),
    suggestionId: id,
    reason: SuggestionFailureReasonSchema,
    ...envelope,
  })
  .strict();
const FeedbackSaved = z
  .object({
    type: z.literal('feedbackSaved'),
    suggestionId: id,
    signals: z.array(FeedbackSignalSchema),
    ...envelope,
  })
  .strict();

export const ServerMessageSchema = z.discriminatedUnion('type', [
  Ready,
  Session,
  Snapshot,
  State,
  Interim,
  Final,
  Status,
  ErrorMessage,
  Pong,
  SuggestionStarted,
  SuggestionToken,
  SuggestionCompleted,
  SuggestionDropped,
  FeedbackSaved,
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** Omit applied to each member of a union separately (plain Omit would merge them). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A server message before the envelope (seq, serverTs) is stamped on. */
export type ServerMessageBody = DistributiveOmit<ServerMessage, 'seq' | 'serverTs'>;

/** Application close codes (4000–4999 are reserved for apps by RFC 6455). */
export const CLOSE_CODE = {
  serverShutdown: 1001,
  internal: 1011,
  unauthorized: 4401,
  forbidden: 4403,
  notFound: 4404,
  helloTimeout: 4408,
  messageTooLarge: 4413,
  clientTooSlow: 4429,
} as const;

export type ParseResult<T> = { ok: true; message: T } | { ok: false; error: string };

/** Parse an inbound client frame: size limit, then JSON, then schema. */
export function parseClientMessage(raw: string): ParseResult<ClientMessage> {
  // TextEncoder works in both Node and browsers (Buffer is Node-only).
  if (new TextEncoder().encode(raw).length > MAX_CLIENT_MESSAGE_BYTES) {
    return { ok: false, error: 'message too large' };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  const parsed = ClientMessageSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return { ok: true, message: parsed.data };
}

/** Parse an inbound server frame on the client. */
export function parseServerMessage(raw: string): ParseResult<ServerMessage> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  const parsed = ServerMessageSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) };
  return { ok: true, message: parsed.data };
}
