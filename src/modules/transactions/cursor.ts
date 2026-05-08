/**
 * Opaque cursor for time-descending pagination.
 *
 * Encodes the (block_time_ms, signature, log_index) triple of the LAST row
 * of the previous page. Each follow-up query asks for rows strictly older
 * than that triple in lexicographic order — stable across re-projection
 * because both `signature` and `log_index` are part of the upsert key on
 * every projection table.
 *
 * Wire format: base64url(`<blockTimeMs>|<signature>|<logIndex>`).
 *   - blockTimeMs is an integer (Date.getTime()).
 *   - signature is the original base58 transaction signature (no inner
 *     pipes, validated on decode).
 *   - logIndex is a non-negative integer.
 *
 * Why include the signature + log_index alongside block_time:
 *   block_time is at second precision on Solana. Many events can share the
 *   same block_time. Without the secondary keys we'd see duplicate rows
 *   on page boundaries (the same row included as both "last of page N" and
 *   "first of page N+1").
 */

export interface DecodedCursor {
  blockTimeMs: number;
  signature: string;
  logIndex: number;
}

const SEP = '|';

export function encodeCursor(c: DecodedCursor): string {
  if (!Number.isFinite(c.blockTimeMs) || c.blockTimeMs < 0) {
    throw new Error('encodeCursor: blockTimeMs must be a non-negative finite number');
  }
  if (!Number.isInteger(c.logIndex) || c.logIndex < 0) {
    throw new Error('encodeCursor: logIndex must be a non-negative integer');
  }
  if (typeof c.signature !== 'string' || c.signature.length === 0) {
    throw new Error('encodeCursor: signature must be a non-empty string');
  }
  if (c.signature.includes(SEP)) {
    throw new Error('encodeCursor: signature must not contain "|"');
  }
  const raw = `${Math.trunc(c.blockTimeMs)}${SEP}${c.signature}${SEP}${c.logIndex}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor. Throws on any structural problem; callers should
 * translate the throw into an HTTP 400 (`BadRequestException`) so clients
 * see "invalid cursor" rather than a 500.
 */
export function decodeCursor(s: string): DecodedCursor {
  if (typeof s !== 'string' || s.length === 0) {
    throw new Error('decodeCursor: empty cursor');
  }
  let raw: string;
  try {
    raw = Buffer.from(s, 'base64url').toString('utf8');
  } catch {
    throw new Error('decodeCursor: not valid base64url');
  }
  const parts = raw.split(SEP);
  if (parts.length !== 3) {
    throw new Error('decodeCursor: malformed cursor');
  }
  const [tStr, signature, lStr] = parts;
  const blockTimeMs = Number(tStr);
  const logIndex = Number(lStr);
  if (!Number.isFinite(blockTimeMs) || blockTimeMs < 0) {
    throw new Error('decodeCursor: malformed blockTimeMs');
  }
  if (!Number.isInteger(logIndex) || logIndex < 0) {
    throw new Error('decodeCursor: malformed logIndex');
  }
  if (!signature || signature.length === 0) {
    throw new Error('decodeCursor: empty signature');
  }
  return { blockTimeMs: Math.trunc(blockTimeMs), signature, logIndex };
}
