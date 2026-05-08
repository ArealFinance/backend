/**
 * Pure helper: extract a JWT from a Socket.IO handshake.
 *
 * Two transports, header WINS over body:
 *   1. `Authorization: Bearer <jwt>` HTTP header (preferred — same shape as
 *      REST). Browsers can't always set this on the WS upgrade, so we also
 *      accept:
 *   2. `auth.token` field on the Socket.IO handshake body
 *      (`io(url, { auth: { token } })`).
 *
 * Returning null is non-fatal: anonymous connections are allowed and only
 * gain access to public rooms (`protocol`, `pool:*`). The decision to
 * accept/reject a private room (`wallet:*`) lives in the gateway.
 *
 * The signature accepts `unknown` so the same helper works against the
 * real `Socket` from `socket.io` and against fake objects in unit tests
 * (we never need the full Socket interface here, only the handshake).
 */
export interface HandshakeLike {
  handshake: {
    headers?: Record<string, string | string[] | undefined>;
    auth?: Record<string, unknown>;
  };
}

const BEARER_RE = /^Bearer\s+(\S+)$/i;

export function extractJwtFromHandshake(socket: HandshakeLike): string | null {
  const handshake = socket?.handshake;
  if (!handshake) return null;

  // Header path (preferred). Header values can be string | string[]; we
  // only accept the canonical single-value form.
  const headerVal = handshake.headers?.authorization ?? handshake.headers?.Authorization;
  if (typeof headerVal === 'string') {
    const m = BEARER_RE.exec(headerVal.trim());
    if (m && m[1]) return m[1];
  }

  // Auth-payload path (Socket.IO body).
  const auth = handshake.auth;
  if (auth && typeof auth === 'object') {
    const token = (auth as { token?: unknown }).token;
    if (typeof token === 'string' && token.length > 0) return token;
  }

  return null;
}
