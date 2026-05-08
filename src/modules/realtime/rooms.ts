/**
 * Room name conventions for the `/realtime` Socket.IO namespace.
 *
 * Public rooms (no auth required):
 *   - `protocol`           — protocol-wide summary tick
 *   - `pool:<base58>`      — per-pool snapshot tick + activity
 *
 * Private rooms (JWT required, sub must match):
 *   - `wallet:<base58>`    — per-wallet transaction-indexed events
 *
 * Two-way knowledge: this file is the single source of truth for room
 * naming and for the regex used to validate client-supplied room strings
 * before joining. Any new room type must:
 *   1. Add a constant / builder here.
 *   2. Add a regex entry to ROOM_PATTERNS.
 *   3. Update RealtimeGateway's auth gate to mark public-vs-private.
 */

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const PROTOCOL_ROOM = 'protocol' as const;

export function poolRoom(pubkey: string): string {
  return `pool:${pubkey}`;
}

export function walletRoom(pubkey: string): string {
  return `wallet:${pubkey}`;
}

export type RoomType = 'protocol' | 'pool' | 'wallet';

/**
 * Parse a client-supplied room name into its `(type, pubkey | null)` parts.
 * Returns null when the format doesn't match any known room shape — caller
 * MUST reject with an `ack` error rather than join an attacker-controlled
 * arbitrary room name (which would let a client mass-spam itself with no
 * effect, but bloats the metric by `room_type='unknown'` labels).
 */
export function parseRoom(name: string): { type: RoomType; pubkey: string | null } | null {
  if (typeof name !== 'string' || name.length === 0) return null;
  if (name === PROTOCOL_ROOM) return { type: 'protocol', pubkey: null };
  if (name.startsWith('pool:')) {
    const pk = name.slice('pool:'.length);
    if (BASE58_RE.test(pk)) return { type: 'pool', pubkey: pk };
    return null;
  }
  if (name.startsWith('wallet:')) {
    const pk = name.slice('wallet:'.length);
    if (BASE58_RE.test(pk)) return { type: 'wallet', pubkey: pk };
    return null;
  }
  return null;
}

export { BASE58_RE };
