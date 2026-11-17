'use server';

import { signTicket } from '@cue/shared/ticket';
import { serverConfig } from '@/config';
import { requireUser } from '@/server/session';

/**
 * A 60-second, single-use ticket for opening the realtime WebSocket as the
 * signed-in user. Called by the replay player before every (re)connect.
 * Signed out → requireUser() redirects to /signin.
 */
export async function getRealtimeTicket(): Promise<string> {
  const user = await requireUser();
  return signTicket(user.id, serverConfig().realtimeTicketSecret);
}
