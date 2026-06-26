/**
 * Shared client-IP resolution for per-IP throttling.
 *
 * Both the REST throttler (`RpcProxyThrottlerGuard`) and the WebSocket
 * handshake throttle (`realtime.gateway.ts`) MUST key on the same client IP,
 * otherwise an attacker could be throttled on one transport but free on the
 * other, and the two paths could disagree on what "one client" means. This
 * module is the single source of that logic.
 *
 * Trust model (R-12.3.1):
 *   - In production the API sits behind Cloudflared / nginx, which OVERWRITE
 *     `x-forwarded-for` with the real client chain (stripping any
 *     client-supplied value). So in prod we trust the leftmost XFF entry,
 *     falling back to `x-real-ip`, then the direct socket address.
 *   - In dev / staging a curl from localhost can set XFF freely, so we IGNORE
 *     the header and use the direct connection address — otherwise an attacker
 *     on the LAN could bypass the per-IP throttle by varying XFF.
 *
 *   We deliberately do NOT enable Express `trust proxy` — that would make
 *   `req.ip` derive from a client-spoofable XFF in ALL environments. Gating on
 *   `NODE_ENV==='production'` (where the proxy is known to rewrite the header)
 *   is the safe equivalent.
 *
 * Normalisation: strip the `::ffff:` IPv4-mapped-IPv6 prefix Node surfaces on
 * dual-stack listeners so `1.2.3.4` and `::ffff:1.2.3.4` don't become two keys.
 */

/** True when XFF/X-Real-IP may be trusted (production only). */
export const IP_HEADER_TRUSTED = process.env.NODE_ENV === 'production';

/** A header value as Node exposes it: string, string[] (repeated), or absent. */
type HeaderValue = string | string[] | undefined;

/** Pick the first string from a possibly-repeated header. */
function firstHeader(value: HeaderValue): string | undefined {
  const flat = Array.isArray(value) ? value[0] : value;
  return typeof flat === 'string' && flat.length > 0 ? flat : undefined;
}

/** Strip the IPv4-mapped-IPv6 prefix; return as-is otherwise. */
function normalize(raw: string): string {
  return raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
}

/**
 * Resolve the originating client IP from a header map + a direct fallback
 * address.
 *
 * @param headers       incoming headers (case-insensitive keys as Node lowercases them)
 * @param fallbackAddr  the direct socket address (`req.ip` / handshake.address)
 * @param trusted       whether header-based resolution is allowed (defaults to
 *                      `IP_HEADER_TRUSTED`; injectable for tests)
 */
export function resolveClientIpFromHeaders(
  headers: Record<string, HeaderValue>,
  fallbackAddr: string | undefined,
  trusted: boolean = IP_HEADER_TRUSTED,
): string {
  let raw: string | undefined;

  if (trusted) {
    const xff = firstHeader(headers['x-forwarded-for']);
    if (xff) {
      // XFF can carry a chain `client, proxy1, proxy2`; the leftmost is the
      // originating client.
      raw = xff.split(',')[0]?.trim();
    }
    if (!raw) {
      // Fall back to X-Real-IP (nginx sets this to the single client IP).
      raw = firstHeader(headers['x-real-ip'])?.trim();
    }
  }

  if (!raw) raw = fallbackAddr;
  if (!raw) return 'unknown';
  return normalize(raw);
}
