import { describe, expect, it } from 'vitest';

import { type DecodedCursor, decodeCursor, encodeCursor } from './cursor.js';

/**
 * Cursor encode/decode is pure — no DI, no DB. We exhaustively check the
 * round-trip for all the boundary shapes and reject every malformed input
 * the controller could see (the controller wraps decode failures into a
 * 400, so a wrong reject here would leak as a 500).
 */
describe('cursor', () => {
  const sample: DecodedCursor = {
    blockTimeMs: 1_715_040_000_000,
    signature:
      '5Hxk2bj9ZkwYmEZX5KqfPnvKLp5N7T4XU8w3aRgFfYwBcXNzpqRyTsK6m1nQqXmWJjLcVrFhFwQqUe6tHnaG8Ar',
    logIndex: 0,
  };

  it('round-trips a typical cursor', () => {
    const enc = encodeCursor(sample);
    expect(decodeCursor(enc)).toEqual(sample);
  });

  it('round-trips boundary values (0 blockTimeMs, large logIndex)', () => {
    const c: DecodedCursor = {
      blockTimeMs: 0,
      // Real-shaped signature so the post-decode SIGNATURE_RE check passes.
      signature:
        '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM6asCMcsj7yyKjj9Lvgrb6h5GwzKy2nW2g5fKVpXkY8WRR',
      logIndex: 2147483647,
    };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it('produces base64url output (no `+`, `/`, or `=` padding)', () => {
    const enc = encodeCursor(sample);
    expect(enc).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects negative blockTimeMs at encode', () => {
    expect(() => encodeCursor({ ...sample, blockTimeMs: -1 })).toThrow(/blockTimeMs/);
  });

  it('rejects non-integer logIndex at encode', () => {
    expect(() => encodeCursor({ ...sample, logIndex: 0.5 })).toThrow(/logIndex/);
    expect(() => encodeCursor({ ...sample, logIndex: -1 })).toThrow(/logIndex/);
  });

  it('rejects empty signature at encode', () => {
    expect(() => encodeCursor({ ...sample, signature: '' })).toThrow(/signature/);
  });

  it('rejects signatures containing the separator', () => {
    expect(() => encodeCursor({ ...sample, signature: 'has|pipe' })).toThrow(/"\|"/);
  });

  it('rejects empty cursor at decode', () => {
    expect(() => decodeCursor('')).toThrow(/empty/);
  });

  it('rejects cursors with the wrong number of parts', () => {
    const broken = Buffer.from('only|two', 'utf8').toString('base64url');
    expect(() => decodeCursor(broken)).toThrow(/malformed/);
  });

  it('rejects cursors with non-numeric blockTimeMs', () => {
    const broken = Buffer.from('notanumber|sig|0', 'utf8').toString('base64url');
    expect(() => decodeCursor(broken)).toThrow(/blockTimeMs/);
  });

  it('rejects cursors with non-integer logIndex', () => {
    const broken = Buffer.from('1234|sig|3.14', 'utf8').toString('base64url');
    expect(() => decodeCursor(broken)).toThrow(/logIndex/);
  });

  it('rejects cursors with empty signature segment', () => {
    const broken = Buffer.from('1234||0', 'utf8').toString('base64url');
    expect(() => decodeCursor(broken)).toThrow(/signature/);
  });

  it('truncates fractional blockTimeMs at encode (defensive)', () => {
    const c: DecodedCursor = { ...sample, blockTimeMs: 1234.99 };
    const enc = encodeCursor(c);
    expect(decodeCursor(enc).blockTimeMs).toBe(1234);
  });

  it('rejects cursors whose signature segment fails the base58 alphabet', () => {
    // `0` and `O` are NOT in the base58 alphabet — typo-shaped probes that
    // should never decode as a valid signature.
    const broken = Buffer.from(`1234|${'0'.repeat(80)}|0`, 'utf8').toString('base64url');
    expect(() => decodeCursor(broken)).toThrow(/signature/);
  });

  it('rejects oversized input before any decode work', () => {
    // 257 base64url chars — one over the cap.
    const oversized = 'A'.repeat(257);
    expect(() => decodeCursor(oversized)).toThrow(/oversized/);
  });

  it('rejects input with non-base64url characters (`+`, `/`, `=`)', () => {
    expect(() => decodeCursor('abc+def')).toThrow(/base64url/);
    expect(() => decodeCursor('abc/def')).toThrow(/base64url/);
    expect(() => decodeCursor('abc=def')).toThrow(/base64url/);
    expect(() => decodeCursor('abc.def')).toThrow(/base64url/);
  });
});
