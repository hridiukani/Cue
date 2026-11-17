import { verifyTicket } from '@cue/shared/ticket';
import type { Clock } from '../clock';

export type TicketCheck =
  | { ok: true; userId: string }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' | 'too_long_lived' | 'reused' };

/**
 * Verifies WebSocket tickets and makes each one single-use: a ticket's jti is
 * remembered until the ticket expires, so a leaked ticket can't open a second
 * connection. (In memory: with several realtime instances this would move to a
 * shared store, but tickets live 60 s, so the window is small.)
 */
export class TicketVerifier {
  private readonly used = new Map<string, number>(); // jti → exp (epoch seconds)

  constructor(
    private readonly secret: string,
    private readonly clock: Clock,
  ) {}

  check(ticket: string): TicketCheck {
    const now = this.clock.now();
    this.prune(now);
    const result = verifyTicket(ticket, this.secret, now);
    if (!result.ok) return result;
    if (this.used.has(result.payload.jti)) return { ok: false, reason: 'reused' };
    this.used.set(result.payload.jti, result.payload.exp);
    return { ok: true, userId: result.payload.sub };
  }

  private prune(nowMs: number): void {
    const nowSeconds = Math.floor(nowMs / 1000);
    for (const [jti, exp] of this.used) if (exp <= nowSeconds) this.used.delete(jti);
  }
}
