/**
 * Parse an HTTP `Range` request header (RFC 9110 §14) for one resource of
 * `size` bytes. Media elements use it to seek: they ask for `bytes=N-`.
 *
 * - No header, another unit, a malformed value, or several ranges: serve the
 *   whole file (200). Ignoring a Range header is always allowed, and we don't
 *   build multipart responses.
 * - `bytes=a-b`, `bytes=a-` and `bytes=-n` (the last n bytes): one inclusive
 *   range, clamped to the file (206).
 * - A range that starts past the end, `bytes=-0`, or any range on an empty
 *   file: unsatisfiable (416).
 */
export type RangeResult =
  { kind: 'full' } | { kind: 'partial'; start: number; end: number } | { kind: 'unsatisfiable' };

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/i;
const MAX_HEADER_LENGTH = 200;

export function parseRangeHeader(header: string | null, size: number): RangeResult {
  if (header === null) return { kind: 'full' };
  const value = header.trim();
  if (value === '' || value.length > MAX_HEADER_LENGTH) return { kind: 'full' };
  const match = SINGLE_RANGE.exec(value);
  if (!match) return { kind: 'full' }; // unknown unit, several ranges, or junk
  const [, first = '', last = ''] = match;
  if (first === '' && last === '') return { kind: 'full' }; // "bytes=-"

  const a = first === '' ? null : Number(first);
  const b = last === '' ? null : Number(last);
  if ((a !== null && !Number.isSafeInteger(a)) || (b !== null && !Number.isSafeInteger(b))) {
    return { kind: 'full' };
  }

  if (a === null) {
    // Suffix range: the last b bytes.
    if (b === null || b === 0 || size === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(0, size - b), end: size - 1 };
  }
  if (b !== null && b < a) return { kind: 'full' }; // invalid syntax: ignore it
  if (a >= size) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start: a, end: b === null ? size - 1 : Math.min(b, size - 1) };
}
