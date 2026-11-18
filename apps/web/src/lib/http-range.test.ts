import { describe, expect, it } from 'vitest';
import { parseRangeHeader } from './http-range';

const SIZE = 1000;

describe('parseRangeHeader', () => {
  it.each([
    [null],
    [''],
    ['   '],
    ['items=0-10'], // another unit
    ['bytes=0-1,5-6'], // several ranges: we serve the whole file
    ['bytes=abc'],
    ['bytes=-'],
    ['bytes=10-5'], // last < first: invalid, so ignored
    [`bytes=0-${'9'.repeat(400)}`], // absurdly long
    ['bytes=99999999999999999999-'], // not a safe integer
  ])('serves the whole file for %j', (header) => {
    expect(parseRangeHeader(header, SIZE)).toEqual({ kind: 'full' });
  });

  it.each([
    ['bytes=0-0', 0, 0],
    ['bytes=0-99', 0, 99],
    ['bytes=500-', 500, 999],
    ['bytes=999-', 999, 999],
    ['bytes=900-5000', 900, 999], // clamped to the last byte
    ['bytes=-100', 900, 999], // the last 100 bytes
    ['bytes=-5000', 0, 999], // suffix longer than the file
    ['BYTES=1-2', 1, 2], // the unit is case-insensitive
    [' bytes=1-2 ', 1, 2],
  ])('%j → bytes %i-%i', (header, start, end) => {
    expect(parseRangeHeader(header, SIZE)).toEqual({ kind: 'partial', start, end });
  });

  it.each([['bytes=1000-'], ['bytes=1000-2000'], ['bytes=-0']])('%j is unsatisfiable', (header) => {
    expect(parseRangeHeader(header, SIZE)).toEqual({ kind: 'unsatisfiable' });
  });

  it('treats any range on an empty file as unsatisfiable', () => {
    expect(parseRangeHeader('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=-10', 0)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader(null, 0)).toEqual({ kind: 'full' });
  });
});
