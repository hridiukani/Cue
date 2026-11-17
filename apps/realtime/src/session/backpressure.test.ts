import { describe, expect, it } from 'vitest';
import { BACKPRESSURE, shouldSend, slowClientAction } from './backpressure';

const KB = 1024;
const MB = 1024 * KB;

describe('shouldSend', () => {
  it('drops interims once the socket buffer is over 256 KB', () => {
    expect(shouldSend('interim', 100 * KB)).toBe(true);
    expect(shouldSend('interim', 300 * KB)).toBe(false);
  });

  it('never drops finals, state or status', () => {
    expect(shouldSend('essential', 100 * MB)).toBe(true);
  });
});

describe('slowClientAction', () => {
  it('pauses when the buffer passes 4 MB', () => {
    expect(slowClientAction(3 * MB, false, null, 0)).toBe('ok');
    expect(slowClientAction(5 * MB, false, null, 0)).toBe('pause');
  });

  it('recovers only once the buffer has drained below the interim threshold', () => {
    expect(slowClientAction(1 * MB, true, 0, 1000)).toBe('pause');
    expect(slowClientAction(100 * KB, true, 0, 1000)).toBe('recovered');
  });

  it('gives up after 15 s stuck above 4 MB', () => {
    expect(slowClientAction(5 * MB, true, 0, BACKPRESSURE.closeAfterMs - 1)).toBe('pause');
    expect(slowClientAction(5 * MB, true, 0, BACKPRESSURE.closeAfterMs)).toBe('close');
  });
});
