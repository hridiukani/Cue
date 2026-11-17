import { createHmac, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signTicket, TICKET_TTL_SECONDS, verifyTicket } from './ticket';

const SECRET = 'a'.repeat(32);
const USER = randomUUID();
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

describe('ticket', () => {
  it('round-trips: a fresh ticket verifies and names the user', () => {
    const r = verifyTicket(signTicket(USER, SECRET, NOW), SECRET, NOW);
    expect(r.ok && r.payload.sub).toBe(USER);
  });

  it('gives every ticket a unique jti', () => {
    const a = verifyTicket(signTicket(USER, SECRET, NOW), SECRET, NOW);
    const b = verifyTicket(signTicket(USER, SECRET, NOW), SECRET, NOW);
    expect(a.ok && b.ok && a.payload.jti !== b.payload.jti).toBe(true);
  });

  it('expires after the TTL', () => {
    const t = signTicket(USER, SECRET, NOW);
    expect(verifyTicket(t, SECRET, NOW + TICKET_TTL_SECONDS * 1000)).toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('rejects a ticket signed with another secret', () => {
    expect(verifyTicket(signTicket(USER, 'b'.repeat(32), NOW), SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a tampered payload (e.g. swapping in another user id)', () => {
    const [v, , sig] = signTicket(USER, SECRET, NOW).split('.');
    const forged = Buffer.from(
      JSON.stringify({ sub: randomUUID(), exp: NOW / 1000 + 30, jti: randomUUID() }),
    ).toString('base64url');
    expect(verifyTicket(`${v ?? ''}.${forged}.${sig ?? ''}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a correctly signed ticket that claims an overly long lifetime', () => {
    const body = Buffer.from(
      JSON.stringify({ sub: USER, exp: NOW / 1000 + 3600, jti: randomUUID() }),
    ).toString('base64url');
    const sig = createHmac('sha256', SECRET).update(`v1.${body}`).digest('base64url');
    expect(verifyTicket(`v1.${body}.${sig}`, SECRET, NOW)).toEqual({
      ok: false,
      reason: 'too_long_lived',
    });
  });

  it.each(['', 'garbage', 'v2.a.b', 'v1.only-two', 'v1.!!.!!'])(
    'rejects malformed input %j',
    (bad) => {
      expect(verifyTicket(bad, SECRET, NOW).ok).toBe(false);
    },
  );
});
