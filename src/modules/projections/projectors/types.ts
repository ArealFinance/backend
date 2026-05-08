import bs58 from 'bs58';

import type { PersistMeta } from '../../indexer/persister.service.js';

/**
 * Shared types and pure helpers used by every projector.
 *
 * Persister ↔ projector contract (Phase 12.1+):
 *   The SDK decoder converts IDL `snake_case` field names to camelCase and
 *   wraps every `[u8;32]` field as a `PublicKey`. The persister then walks
 *   the decoded payload and turns:
 *     - PublicKey instances → base58 strings (`.toBase58()`)
 *     - bigint values       → decimal strings
 *     - raw Buffer (rare)   → hex strings (kept lossless for non-pubkey bufs)
 *   …leaving the JSONB `body` column as `{ camelCaseKey: string|number|... }`.
 *
 *   Projectors read camelCase keys and treat 32-byte fields as already-base58.
 *   `hexToBase58` is exported for the rare case where a future event includes
 *   a non-pubkey 32-byte buffer that the persister fell through to its hex
 *   branch — defensive parity with the persister contract.
 */

export interface ProjectInput {
  /**
   * The decoded event body, post-persister normalisation. Field names are
   * camelCase (SDK convention), 32-byte pubkey fields are base58 strings,
   * u64/u128 amounts are decimal strings, smaller ints (u8/u16/u32) are
   * native numbers.
   */
  data: Record<string, unknown>;
  /**
   * The IDL event name (e.g. `LiquidityAdded`). The dispatcher routes by
   * name, but multi-event projectors (LiquidityProjector handles 4 names)
   * also need it inside the projector to switch on shape.
   */
  eventName: string;
  /** Persister metadata for the wrapping transaction. */
  meta: PersistMeta;
}

/**
 * Convert a hex string into base58. Defensive helper for the corner case
 * where the persister stored a non-pubkey 32-byte buffer as hex (PublicKey
 * fields go through `.toBase58()` and never hit this branch).
 */
export function hexToBase58(hex: string): string {
  if (typeof hex !== 'string' || hex.length === 0) {
    throw new Error(`hexToBase58: expected non-empty string, got ${typeof hex}`);
  }
  const stripped = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (!/^[0-9a-fA-F]+$/.test(stripped) || stripped.length % 2 !== 0) {
    throw new Error('hexToBase58: malformed hex input');
  }
  return bs58.encode(Buffer.from(stripped, 'hex'));
}

/**
 * Reads `data[key]` and asserts it's a non-empty string. Throws with a
 * caller-visible field name on failure — projector errors propagate up to
 * the indexer transaction and roll back, so messages need to be debuggable.
 */
export function requireString(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new Error(`projector: missing/non-string field "${key}"`);
  }
  return v;
}

/**
 * Reads a 32-byte pubkey field. Persister stores these as base58 already,
 * but if a future event introduces a hex-emitted buffer the helper falls
 * back gracefully to hex→base58 conversion.
 */
export function requirePubkey(data: Record<string, unknown>, key: string): string {
  const v = requireString(data, key);
  // Hex encoding is lowercase a–f only; valid base58 uses no `0`/`O`/`I`/`l`
  // and the alphabet does include `a–f` so we can't separate them by character
  // class alone. Rely on length: 32-byte pubkey → 44 base58 chars (43 in rare
  // leading-zero cases, never 64 hex-chars long).
  if (/^[0-9a-fA-F]+$/.test(v) && v.length === 64) {
    return hexToBase58(v);
  }
  return v;
}

/**
 * Big-int-shaped fields. The persister always normalises bigint → string,
 * so the value should be a numeric string by the time we read it. Tolerate
 * `number` as a fallback (defensive for events where the IDL types as a
 * smaller integer the persister kept as native).
 */
export function requireBigStr(data: Record<string, unknown>, key: string): string {
  const v = data[key];
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return v;
  if (typeof v === 'number' && Number.isInteger(v)) return String(v);
  throw new Error(`projector: missing/non-integer field "${key}"`);
}

/**
 * For fields that the IDL types as `u8` / `u16` / `u32` and the persister
 * kept as native JS `number`. Returns a JS number (not a string).
 */
export function requireInt(data: Record<string, unknown>, key: string): number {
  const v = data[key];
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return n;
  }
  throw new Error(`projector: missing/non-integer (small) field "${key}"`);
}

/**
 * Negate a numeric-string. Used for `LiquidityRemoved` where the wire
 * carries `sharesBurned` (positive) and we store `shares_delta` (signed).
 * Avoids JS-number precision loss past 2^53.
 */
export function negateBigStr(s: string): string {
  if (s === '0') return '0';
  return s.startsWith('-') ? s.slice(1) : `-${s}`;
}
