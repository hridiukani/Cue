/**
 * Time, injectable. The replay schedules everything through a Clock so tests
 * can run hours of call timeline instantly and deterministically (FakeClock).
 */
export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

export interface TimerHandle {
  readonly id: number;
}

export const realClock: Clock = (() => {
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let nextId = 1;
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(
        id,
        setTimeout(
          () => {
            timers.delete(id);
            fn();
          },
          Math.max(0, ms),
        ),
      );
      return { id };
    },
    clearTimeout(handle) {
      const t = timers.get(handle.id);
      if (t !== undefined) clearTimeout(t);
      timers.delete(handle.id);
    },
  };
})();

/** Manual clock for tests: time only moves when you call advance(). */
export class FakeClock implements Clock {
  private time: number;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; fn: () => void; seq: number }>();
  private seq = 0;

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Math.max(0, ms), fn, seq: this.seq++ });
    return { id };
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle.id);
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Move time forward, firing due timers in order (including ones they schedule). */
  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; seq: number }] | undefined;
      for (const entry of this.timers) {
        if (entry[1].at > target) continue;
        if (
          !next ||
          entry[1].at < next[1].at ||
          (entry[1].at === next[1].at && entry[1].seq < next[1].seq)
        ) {
          next = entry;
        }
      }
      if (!next) break;
      this.timers.delete(next[0]);
      this.time = next[1].at;
      next[1].fn();
    }
    this.time = target;
  }
}
