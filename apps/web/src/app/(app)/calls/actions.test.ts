import { randomUUID } from 'node:crypto';
import { verifyTicket } from '@cue/shared/ticket';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ user: null as { id: string; email: string; name: null } | null }));
const SECRET = 'k'.repeat(32);

vi.mock('@/server/session', () => ({
  requireUser: () => {
    if (!h.user) throw new Error('NEXT_REDIRECT:/signin');
    return Promise.resolve(h.user);
  },
}));
vi.mock('@/config', () => ({ serverConfig: () => ({ realtimeTicketSecret: SECRET }) }));

const { getRealtimeTicket } = await import('./actions');

describe('getRealtimeTicket', () => {
  beforeEach(() => {
    h.user = null;
  });

  it('issues a ticket for the signed-in user that the realtime server can verify', async () => {
    h.user = { id: randomUUID(), email: 'a@test.local', name: null };
    const ticket = await getRealtimeTicket();
    const v = verifyTicket(ticket, SECRET);
    expect(v.ok && v.payload.sub).toBe(h.user.id);
  });

  it('refuses when signed out', async () => {
    await expect(getRealtimeTicket()).rejects.toThrow(/signin/);
  });
});
