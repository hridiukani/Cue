import { randomUUID } from 'node:crypto';
import { signTicket, TICKET_TTL_SECONDS } from '@cue/shared/ticket';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../clock';
import { TicketVerifier } from './ticket-verifier';

const SECRET = 'x'.repeat(32);

describe('TicketVerifier', () => {
  it('accepts a fresh ticket once and refuses it the second time', () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 17));
    const v = new TicketVerifier(SECRET, clock);
    const user = randomUUID();
    const t = signTicket(user, SECRET, clock.now());
    expect(v.check(t)).toEqual({ ok: true, userId: user });
    expect(v.check(t)).toEqual({ ok: false, reason: 'reused' });
  });

  it('refuses expired, forged and garbage tickets', () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 17));
    const v = new TicketVerifier(SECRET, clock);
    const t = signTicket(randomUUID(), SECRET, clock.now());
    clock.advance(TICKET_TTL_SECONDS * 1000);
    expect(v.check(t)).toEqual({ ok: false, reason: 'expired' });
    expect(v.check(signTicket(randomUUID(), 'y'.repeat(32), clock.now()))).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(v.check('nonsense').ok).toBe(false);
  });

  it('forgets used tickets once they have expired (bounded memory)', () => {
    const clock = new FakeClock(Date.UTC(2026, 10, 17));
    const v = new TicketVerifier(SECRET, clock);
    for (let i = 0; i < 100; i++) v.check(signTicket(randomUUID(), SECRET, clock.now()));
    clock.advance((TICKET_TTL_SECONDS + 1) * 1000);
    v.check('trigger-prune');
    expect((v as unknown as { used: Map<string, number> }).used.size).toBe(0);
  });
});
