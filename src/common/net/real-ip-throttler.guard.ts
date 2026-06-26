import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

import { resolveClientIpFromHeaders } from './client-ip.js';

/**
 * ThrottlerGuard that keys the per-IP rate limit on the REAL client IP.
 *
 * WHY THIS EXISTS: the stock `ThrottlerGuard.getTracker` returns `req.ip`.
 * With Express `trust proxy` OFF (and it MUST stay off — a client-supplied
 * XFF is spoofable), `req.ip` behind Cloudflared/nginx is the single
 * reverse-proxy hop IP. Every external client then collapses into ONE bucket:
 * the per-IP limit silently never applies and one abuser locks out everyone.
 *
 * This guard resolves the originating client IP from `x-forwarded-for` /
 * `x-real-ip` (production only, where the proxy rewrites the header) via the
 * SAME helper the WS handshake throttle uses — so HTTP and WS key identically.
 * In non-prod it falls back to `req.ip`, where the header is untrusted.
 *
 * Registered as the global `APP_GUARD` in place of the stock guard, so every
 * throttled route benefits — not just the RPC proxy.
 */
@Injectable()
export class RealIpThrottlerGuard extends ThrottlerGuard {
  /**
   * @param req the Express request (the throttler passes the request object).
   */
  protected override async getTracker(req: Record<string, unknown>): Promise<string> {
    const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;
    // Direct fallback: `req.ip` (Express), then the raw socket address.
    const socket = req.socket as { remoteAddress?: string } | undefined;
    const fallback = (req.ip as string | undefined) ?? socket?.remoteAddress;
    return resolveClientIpFromHeaders(headers, fallback);
  }
}
