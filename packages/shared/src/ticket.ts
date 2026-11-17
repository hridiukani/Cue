import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/**
 * Short-lived ticket that lets a signed-in browser open a WebSocket to
 * apps/realtime. apps/web signs it (server-side, after requireUser());
 * apps/realtime verifies it. Shared secret: REALTIME_TICKET_SECRET.
 *
 * Format: "v1.<base64url(json payload)>.<base64url(HMAC-SHA256)>".
 * Node-only (node:crypto): exported as `@cue/shared/ticket`, not from the
 * main entry, so it never ends up in a browser bundle.
 */

export const TICKET_TTL_SECONDS = 60;
const VERSION = 'v1';

export const TicketPayloadSchema = z
  .object({
    sub: z.uuid(), // Cue user id
    exp: z.number().int().positive(), // expiry, epoch seconds
    jti: z.uuid(), // unique id, so the realtime server can refuse reuse
  })
  .strict();
export type TicketPayload = z.infer<typeof TicketPayloadSchema>;

export type TicketVerification =
  | { ok: true; payload: TicketPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'too_long_lived' };

function sign(data: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(data).digest();
}

export function signTicket(userId: string, secret: string, nowMs: number = Date.now()): string {
  const payload: TicketPayload = TicketPayloadSchema.parse({
    sub: userId,
    exp: Math.floor(nowMs / 1000) + TICKET_TTL_SECONDS,
    jti: randomUUID(),
  });
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signed = `${VERSION}.${body}`;
  return `${signed}.${sign(signed, secret).toString('base64url')}`;
}

export function verifyTicket(
  ticket: string,
  secret: string,
  nowMs: number = Date.now(),
): TicketVerification {
  const parts = ticket.split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: 'malformed' };
  const [version, body, signature] = parts as [string, string, string];

  const expected = sign(`${version}.${body}`, secret);
  const given = Buffer.from(signature, 'base64url');
  // Constant-time compare so the signature can't be guessed byte by byte.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const parsed = TicketPayloadSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: 'malformed' };

  const nowSeconds = Math.floor(nowMs / 1000);
  if (parsed.data.exp <= nowSeconds) return { ok: false, reason: 'expired' };
  // Defense in depth: refuse tickets claiming to live longer than we ever issue.
  if (parsed.data.exp - nowSeconds > TICKET_TTL_SECONDS + 5) {
    return { ok: false, reason: 'too_long_lived' };
  }
  return { ok: true, payload: parsed.data };
}
