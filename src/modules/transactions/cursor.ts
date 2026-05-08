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

/**
 * Hard cap on raw cursor input length. A well-formed cursor encodes ~95
 * bytes (13-digit ms + `|` + ~88-char base58 sig + `|` + small int) → ~128
 * chars after base64url. 256 leaves comfortable headroom while rejecting
 * obvious DoS / probe payloads before we allocate a Buffer.
 */
const MAX_INPUT_LEN = 256;

/** Base64url alphabet — digits, letters, `-`, `_`. */
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Solana base58 signature: 64 bytes → 87-88 chars typical. We allow 64-90
 * to absorb edge encodings without opening the gate to arbitrary input.
 */
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

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
  if (s.length > MAX_INPUT_LEN) {
    throw new Error('decodeCursor: oversized input');
  }
  if (!BASE64URL_RE.test(s)) {
    throw new Error('decodeCursor: not base64url');
  }
  // `Buffer.from(_, 'base64url')` is total in Node — it silently drops bad
  // chars rather than throwing. The regex above is the real guard, so the
  // decode itself is unconditional.
  const raw = Buffer.from(s, 'base64url').toString('utf8');
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
  if (!SIGNATURE_RE.test(signature)) {
    throw new Error('decodeCursor: malformed signature');
  }
  return { blockTimeMs: Math.trunc(blockTimeMs), signature, logIndex };
}
