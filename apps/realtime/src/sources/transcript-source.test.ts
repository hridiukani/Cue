import { describe, expect, it } from 'vitest';
import { type Clock, FakeClock } from '../clock';
import type { SourceEvent } from './call-source';
import { type TimedUtterance, TranscriptSource } from './transcript-source';

const UTTERANCES: TimedUtterance[] = [
  { idx: 0, speaker: 'rep', text: 'hello there how are you', startedMs: 0, endedMs: 1500 },
  { idx: 1, speaker: 'prospect', text: 'fine thanks', startedMs: 2000, endedMs: 3000 },
  { idx: 2, speaker: 'rep', text: 'great', startedMs: 5000, endedMs: 5500 },
];

type Stamped = SourceEvent & { wallMs: number };
type Of<T extends SourceEvent['type']> = Extract<SourceEvent, { type: T }> & { wallMs: number };
const only =
  <T extends SourceEvent['type']>(type: T) =>
  (es: Stamped[]): Of<T>[] =>
    es.filter((e): e is Of<T> => e.type === type);
const interimsOf = only('interim');
const finalsOf = only('final');
const positionsOf = only('position');

function setup(utterances = UTTERANCES) {
  const clock = new FakeClock();
  const source = new TranscriptSource(utterances, clock);
  const events: Stamped[] = [];
  source.on((e) => events.push({ ...e, wallMs: clock.now() }));
  const finals = () => finalsOf(events);
  return { clock, source, events, finals };
}

describe('TranscriptSource', () => {
  it('emits growing interims, then a final at each end time, on the original timeline (1x)', () => {
    const { clock, source, events, finals } = setup();
    source.start(0, '1x');

    clock.advance(1499);
    const interimTexts = interimsOf(events).map((e) => e.text);
    expect(interimTexts.length).toBeGreaterThan(1);
    // Each interim shows at least as many words as the one before.
    expect(interimTexts).toEqual([...interimTexts].sort((a, b) => a.length - b.length));
    expect(finals()).toHaveLength(0);

    clock.advance(1);
    expect(finals().map((e) => [e.wallMs, e.text])).toEqual([[1500, 'hello there how are you']]);

    clock.advance(10_000);
    expect(finals().map((e) => e.wallMs)).toEqual([1500, 3000, 5500]);
    expect(events.at(-1)).toMatchObject({ type: 'ended' });
    expect(source.playing).toBe(false);
  });

  it('runs twice as fast at 2x', () => {
    const { clock, source, finals } = setup();
    source.start(0, '2x');
    clock.advance(10_000);
    expect(finals().map((e) => e.wallMs)).toEqual([750, 1500, 2750]);
  });

  it('emits only finals, all at once, at instant speed', () => {
    const { clock, source, events } = setup();
    source.start(0, 'instant');
    clock.advance(0);
    expect(interimsOf(events)).toHaveLength(0);
    expect(finalsOf(events).map((e) => e.wallMs)).toEqual([0, 0, 0]);
    expect(events.at(-1)?.type).toBe('ended');
  });

  it('reports position during long silences', () => {
    const { clock, source, events } = setup();
    source.start(0, '1x');
    clock.advance(4500); // silence between 3000 and 5000
    const positions = positionsOf(events).map((e) => e.positionMs);
    expect(positions).toContain(4000);
  });

  it('pause stops emitting; resume continues from the same place', () => {
    const { clock, source, finals } = setup();
    source.start(0, '1x');
    clock.advance(1600);
    source.pause();
    clock.advance(60_000);
    expect(finals()).toHaveLength(1);
    expect(source.positionMs).toBe(1600); // where it was paused, not the last event (1500)

    source.resume();
    clock.advance(1399); // 1600 → 2999: not yet
    expect(finals()).toHaveLength(1);
    clock.advance(1); // 3000: the next final, with no time lost to the pause
    expect(finals()).toHaveLength(2);
  });

  it('reports the live position between events, never past the next one', () => {
    const { clock, source } = setup();
    source.start(0, '1x');
    clock.advance(1700); // last event at 1600 (an interim/tick), next at 2000
    expect(source.positionMs).toBe(1700);
    source.setSpeed('2x');
    clock.advance(100);
    expect(source.positionMs).toBe(1900);
  });

  it('a speed change between events keeps the time already played', () => {
    const { clock, source, finals } = setup();
    source.start(0, '1x');
    clock.advance(2700); // timeline 2700, mid-utterance 1 (ends at 3000)
    source.setSpeed('2x');
    clock.advance(149); // 300 ms of timeline left at 2x = 150 ms
    expect(finals()).toHaveLength(1);
    clock.advance(1);
    expect(finals().map((e) => [e.key, e.wallMs])).toEqual([
      ['u-0', 1500],
      ['u-1', 2850],
    ]);
  });

  it('does not fall behind the recording however often the speed changes', () => {
    // One long utterance, like real-sales: events every 300 ms, switches in between.
    const words = Array.from({ length: 200 }, (_, i) => `w${String(i)}`).join(' ');
    const { clock, source, finals } = setup([
      { idx: 0, speaker: 'prospect', text: words, startedMs: 0, endedMs: 120_000 },
    ]);
    source.start(0, '1x');
    let ideal = 0; // a stopwatch for the timeline
    let rate = 1;
    for (let i = 0; i < 20; i++) {
      clock.advance(1234);
      ideal += 1234 * rate;
      rate = rate === 1 ? 2 : 1;
      source.setSpeed(rate === 2 ? '2x' : '1x');
    }
    expect(source.positionMs).toBe(ideal); // nothing lost over 20 switches
    // And the final arrives exactly when the stopwatch says it should.
    const wallLeft = (120_000 - ideal) / rate;
    clock.advance(wallLeft - 1);
    expect(finals()).toHaveLength(0);
    clock.advance(1);
    expect(finals()).toHaveLength(1);
  });

  it('seek forward skips earlier utterances; stale timers never fire', () => {
    const { clock, source, finals } = setup();
    source.start(0, '1x');
    clock.advance(100);
    source.seek(2500); // mid-utterance 1
    clock.advance(10_000);
    expect(finals().map((e) => e.key)).toEqual(['u-1', 'u-2']);
  });

  it('starting from a position is inclusive, so an utterance ending exactly there is emitted', () => {
    const { clock, source, finals } = setup();
    source.start(3000, '1x');
    clock.advance(0);
    expect(finals().map((e) => e.key)).toEqual(['u-1']);
  });

  it('changing speed mid-play reschedules from the current position', () => {
    const { clock, source, finals } = setup();
    source.start(0, '1x');
    clock.advance(1500); // first final at 1500
    source.setSpeed('2x');
    clock.advance(750); // 1500 + 1500/2 = 3000 timeline
    expect(finals()).toHaveLength(2);
  });

  it('late timers do not add up: the timeline stays on the wall clock', () => {
    // Like a real event loop: every timer fires 5 ms after it was due.
    const fake = new FakeClock();
    const late: Clock = {
      now: () => fake.now(),
      setTimeout: (fn, ms) => fake.setTimeout(fn, ms + 5),
      clearTimeout: (h) => {
        fake.clearTimeout(h);
      },
    };
    const words = Array.from({ length: 200 }, (_, i) => `w${String(i)}`).join(' ');
    const source = new TranscriptSource(
      [{ idx: 0, speaker: 'prospect', text: words, startedMs: 0, endedMs: 60_000 }],
      late,
    );
    const finalsAt: number[] = [];
    source.on((e) => {
      if (e.type === 'final') finalsAt.push(fake.now());
    });
    source.start(0, '2x');
    fake.advance(40_000);
    // Due at 30 000 ms (60 s of timeline at 2x): ~300 events in between, each 5 ms late,
    // would have pushed it ~1.5 s back. Now it's only as late as one timer.
    expect(finalsAt).toHaveLength(1);
    expect(finalsAt[0]).toBeLessThanOrEqual(30_005);
  });

  it('close stops everything and leaves no timers behind', async () => {
    const { clock, source, events } = setup();
    source.start(0, '1x');
    await source.close();
    const n = events.length;
    clock.advance(60_000);
    expect(events.length).toBe(n);
    expect(clock.pendingTimers).toBe(0);
  });
});
