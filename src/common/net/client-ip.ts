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
 *   - In production the API sits behind Cloudflare (orange-cloud) → nginx.
 *     Resolution order, most-trusted first:
 *       1. `CF-Connecting-IP` — Cloudflare sets this to the SINGLE real client
 *          IP and OVERWRITES any client-supplied value, so it is unspoofable
 *          behind CF. Prefer it whenever present.
 *       2. `X-Real-IP` — nginx sets this to the single client IP.
 *       3. leftmost `X-Forwarded-For` — last resort. NOTE: nginx uses
 *          `$proxy_add_x_forwarded_for`, which APPENDS to any client-supplied
 *          XFF, so the leftmost hop here can be CLIENT-SPOOFED. We only fall
 *          back to it when both unspoofable headers above are absent (which,
 *          behind CF, they never are) — keeping a sane key for non-CF paths
 *          without letting a forged XFF bypass the per-IP throttle on the CF
 *          path. This ordering is the whole reason the proxy's per-IP rate
 *          limit (which protects the paid Helius quota) can't be rotated past.
 *     Falls back to the direct socket address when none of the three are set.
 *   - In dev / staging a curl from localhost can set any of these freely, so we
 *     IGNORE all of them and use the direct connection address — otherwise an
 *     attacker on the LAN could bypass the per-IP throttle by varying a header.
 *
 *   We deliberately do NOT enable Express `trust proxy` — that would make
 *   `req.ip` derive from a client-spoofable XFF in ALL environments. Gating on
 *   `NODE_ENV==='production'` (where CF/nginx are known to set the trusted
 *   headers) is the safe equivalent.
 *
 * Normalisation: strip the `::ffff:` IPv4-mapped-IPv6 prefix Node surfaces on
 * dual-stack listeners so `1.2.3.4` and `::ffff:1.2.3.4` don't become two keys.
 */

/** True when proxy-supplied client-IP headers may be trusted (production only). */
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
    // 1. CF-Connecting-IP — Cloudflare overwrites any client-supplied value
    //    with the single real client IP, so it's unspoofable behind CF. This
    //    MUST be checked before XFF: nginx's `$proxy_add_x_forwarded_for`
    //    appends to a client-supplied XFF, so a forged leftmost XFF hop could
    //    otherwise rotate past the per-IP throttle.
    raw = firstHeader(headers['cf-connecting-ip'])?.trim();

    if (!raw) {
      // 2. X-Real-IP — nginx sets this to the single client IP.
      raw = firstHeader(headers['x-real-ip'])?.trim();
    }

    if (!raw) {
      // 3. Leftmost X-Forwarded-For (last resort; spoofable on non-CF paths —
      //    see the module doc comment). XFF can carry a chain
      //    `client, proxy1, proxy2`; the leftmost is the originating client.
      const xff = firstHeader(headers['x-forwarded-for']);
      if (xff) raw = xff.split(',')[0]?.trim();
    }
  }

  if (!raw) raw = fallbackAddr;
  if (!raw) return 'unknown';
  return normalize(raw);
}
