import { describe, expect, it } from 'vitest';
import {
  ESTIMATE,
  estimateTimeline,
  mapSpeaker,
  normalizeTimeline,
  parseWavHeader,
  pickMetadata,
} from './core';

describe('mapSpeaker', () => {
  it.each([
    ['Seller', 'rep'],
    ['Sales Rep', 'rep'],
    ['sales_rep', 'rep'],
    ['Partner', 'prospect'],
    ['Customer', 'prospect'],
    ['customer', 'prospect'],
    [' Sales   Rep ', 'rep'],
  ])('%s → %s', (label, expected) => {
    expect(mapSpeaker(label)).toBe(expected);
  });

  it('returns null for unknown labels instead of guessing', () => {
    expect(mapSpeaker('Narrator')).toBeNull();
  });
});

describe('estimateTimeline', () => {
  it('lays turns out back to back with a pause, ~160 words per minute', () => {
    const t = estimateTimeline([
      { speaker: 'rep', text: 'one two three four' }, // 4 words → 1500 ms
      { speaker: 'prospect', text: 'ok' }, // 1 word → minimum 800 ms
    ]);
    expect(t).toEqual([
      { speaker: 'rep', text: 'one two three four', startedMs: 0, endedMs: 4 * ESTIMATE.msPerWord },
      {
        speaker: 'prospect',
        text: 'ok',
        startedMs: 1500 + ESTIMATE.gapMs,
        endedMs: 1500 + ESTIMATE.gapMs + ESTIMATE.minUtteranceMs,
      },
    ]);
  });
});

describe('normalizeTimeline', () => {
  it('sorts, drops empty text and repairs end-before-start, counting each fix', () => {
    const { turns, reordered, repaired } = normalizeTimeline([
      { speaker: 'rep', text: 'second', startedMs: 2000, endedMs: 2500 },
      { speaker: 'prospect', text: '   ', startedMs: 500, endedMs: 600 },
      { speaker: 'prospect', text: 'first', startedMs: 1000, endedMs: 900 },
    ]);
    expect(turns.map((t) => [t.text, t.startedMs, t.endedMs])).toEqual([
      ['first', 1000, 1000],
      ['second', 2000, 2500],
    ]);
    expect({ reordered, repaired }).toEqual({ reordered: 1, repaired: 1 });
  });

  it('reports zero fixes for clean, ordered input (dropping blanks is not a fix)', () => {
    const r = normalizeTimeline([
      { speaker: 'rep', text: 'a', startedMs: 0, endedMs: 10 },
      { speaker: 'rep', text: '', startedMs: 5, endedMs: 6 },
      { speaker: 'prospect', text: 'b', startedMs: 20, endedMs: 30 },
    ]);
    expect({ reordered: r.reordered, repaired: r.repaired }).toEqual({ reordered: 0, repaired: 0 });
  });
});

describe('pickMetadata', () => {
  it('keeps only allowlisted scalar fields', () => {
    expect(
      pickMetadata({ product_type: 'SaaS', outcome: 1, scenario: { x: 1 }, secret: 'no' }, [
        'product_type',
        'outcome',
        'scenario',
      ]),
    ).toEqual({ product_type: 'SaaS', outcome: 1 });
  });

  it('throws if an allowlist ever includes a demographic field', () => {
    expect(() => pickMetadata({ seller_gender: 'x' }, ['seller_gender'])).toThrow(/Demographic/);
  });
});

describe('parseWavHeader', () => {
  function wav(sampleRate: number, channels: number, dataBytes: number): Buffer {
    const b = Buffer.alloc(44);
    b.write('RIFF', 0, 'ascii');
    b.writeUInt32LE(36 + dataBytes, 4);
    b.write('WAVE', 8, 'ascii');
    b.write('fmt ', 12, 'ascii');
    b.writeUInt32LE(16, 16);
    b.writeUInt16LE(1, 20); // PCM
    b.writeUInt16LE(channels, 22);
    b.writeUInt32LE(sampleRate, 24);
    b.writeUInt32LE(sampleRate * channels * 2, 28);
    b.writeUInt16LE(channels * 2, 32);
    b.writeUInt16LE(16, 34);
    b.write('data', 36, 'ascii');
    b.writeUInt32LE(dataBytes, 40);
    return b;
  }

  it('reads format and duration (stereo 48 kHz, 2 s)', () => {
    expect(parseWavHeader(wav(48000, 2, 48000 * 2 * 2 * 2))).toEqual({
      sampleRate: 48000,
      channels: 2,
      bitsPerSample: 16,
      durationMs: 2000,
    });
  });

  it('returns null for non-WAV data', () => {
    expect(parseWavHeader(Buffer.from('ID3 this is an mp3'))).toBeNull();
  });
});
