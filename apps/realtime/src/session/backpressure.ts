/**
 * What to do when the browser reads slower than we send (bytes queued in the
 * socket, `ws.bufferedAmount`). Interims are disposable (the next one or the
 * final replaces them); finals, state and status are never dropped.
 */
export const BACKPRESSURE = {
  /** Above this, new interims are dropped. */
  dropInterimsAboveBytes: 256 * 1024,
  /** Above this, the replay pauses until the buffer drains below dropInterimsAboveBytes. */
  pauseAboveBytes: 4 * 1024 * 1024,
  /** Still above pauseAboveBytes after this long: give up on the client (close 4429). */
  closeAfterMs: 15_000,
  /** How often to re-check a slow client. */
  pollMs: 250,
} as const;

export type OutboundKind = 'interim' | 'essential';

export function shouldSend(kind: OutboundKind, bufferedBytes: number): boolean {
  return kind === 'essential' || bufferedBytes <= BACKPRESSURE.dropInterimsAboveBytes;
}

export type SlowClientAction = 'ok' | 'pause' | 'recovered' | 'close';

/**
 * Decide what to do about a client, given how full its buffer is, whether we
 * already paused for it, and since when it's been over the pause threshold.
 */
export function slowClientAction(
  bufferedBytes: number,
  pausedForClient: boolean,
  slowSinceMs: number | null,
  nowMs: number,
): SlowClientAction {
  if (pausedForClient) {
    if (bufferedBytes <= BACKPRESSURE.dropInterimsAboveBytes) return 'recovered';
    if (
      bufferedBytes > BACKPRESSURE.pauseAboveBytes &&
      slowSinceMs !== null &&
      nowMs - slowSinceMs >= BACKPRESSURE.closeAfterMs
    ) {
      return 'close';
    }
    return 'pause';
  }
  return bufferedBytes > BACKPRESSURE.pauseAboveBytes ? 'pause' : 'ok';
}
