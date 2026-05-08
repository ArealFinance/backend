import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';

import type { JwtPayload } from '../auth/strategies/jwt.strategy.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { HandshakeThrottleService } from './handshake-throttle.js';
import { extractJwtFromHandshake } from './jwt-handshake.js';
import { parseRoom } from './rooms.js';

/**
 * Trust the `x-forwarded-for` header only in production, where the API sits
 * behind Cloudflared / a known reverse proxy that overwrites the header
 * (so a client-supplied value is replaced before reaching us). In dev a
 * curl from localhost can spoof XFF freely, so we ignore it and use the
 * direct `client.handshake.address` instead — otherwise an attacker on a
 * local LAN could trivially bypass the per-IP throttle by varying XFF.
 */
const IP_HEADER_TRUSTED = process.env.NODE_ENV === 'production';

/**
 * CORS allow-list for the `/realtime` namespace. Mirrored from `main.ts`'s
 * REST-side allow-list so a single edit never lets a new origin reach the
 * REST API while staying blocked on WS (or vice-versa). The redis-adapter
 * shim in `redis-io.adapter.ts` re-applies the same value when constructing
 * the underlying Socket.IO server.
 */
export const REALTIME_ALLOWED_ORIGINS = [
  'https://app.areal.finance',
  'https://panel.areal.finance',
  'http://localhost:5173',
  'http://localhost:5174',
];

type SubscribeBody = { room?: unknown };
type Ack = { ok: true } | { ok: false; error: string };

/**
 * Socket.IO gateway for the `/realtime` namespace.
 *
 * Connection model:
 *   - JWT extraction is best-effort at handshake time. A missing/invalid
 *     token is non-fatal — the connection is established but the socket
 *     gets `data.wallet = null` and is rejected from any private room.
 *   - Public rooms (`protocol`, `pool:<base58>`) accept anonymous
 *     connections — they only ever carry chain-derived data.
 *   - Private rooms (`wallet:<base58>`) require the JWT's `sub` to match
 *     the room's pubkey. Any mismatch returns `{ ok: false }` and never
 *     joins the underlying Socket.IO room.
 *
 * Why the gate lives in the gateway, not in a guard:
 *   `WsAuthGuard`-style guards run BEFORE handler execution but they
 *   throw `WsException` on failure — that closes the whole socket. We
 *   want a softer behaviour: the failed `subscribe` returns an error ack
 *   to the client, the connection stays open so the client can subscribe
 *   to OTHER rooms it does have access to. Hence the inline check.
 */
@WebSocketGateway({
  namespace: '/realtime',
  cors: { origin: REALTIME_ALLOWED_ORIGINS, credentials: true },
})
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  server!: Server;

  constructor(
    private readonly jwt: JwtService,
    private readonly metrics: MetricsService,
    private readonly throttle: HandshakeThrottleService,
  ) {}

  async handleConnection(client: Socket): Promise<void> {
    // Per-IP rate-limit FIRST, BEFORE the JWT verify — the whole point of
    // this gate is to deflect bogus-token connection floods before they
    // burn HMAC CPU. Wrap in try/catch: throttle failures must NEVER block
    // legitimate connections (fail-open).
    const ip = resolveClientIp(client);
    try {
      const verdict = await this.throttle.checkAndRecord(ip);
      if (!verdict.ok) {
        this.logger.warn(
          `handshake rejected: ip=${ip} retry_after=${verdict.retryAfterSec}s`,
        );
        this.metrics.realtimeHandshakeRejected.inc({ reason: 'rate_limit' });
        client.disconnect(true);
        return;
      }
    } catch (err) {
      // Fail-open at the gateway level too (the service already fails open
      // internally; this is belt-and-braces in case a future refactor
      // surfaces an exception we forgot to swallow).
      this.metrics.realtimeHandshakeRejected.inc({ reason: 'redis_error' });
      this.logger.warn(
        `handshake throttle errored for ip=${ip}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const token = extractJwtFromHandshake(client);
    if (token) {
      try {
        const payload = await this.jwt.verifyAsync<JwtPayload>(token);
        if (payload?.sub && typeof payload.sub === 'string') {
          client.data.wallet = payload.sub;
        } else {
          client.data.wallet = null;
        }
      } catch {
        // Verification failure is non-fatal — connection stays anonymous.
        client.data.wallet = null;
      }
    } else {
      client.data.wallet = null;
    }
    this.metrics.realtimeConnections.inc();
  }

  /**
   * Client-driven join. The room name is validated against `parseRoom`
   * (single source of truth for room shapes — see `rooms.ts`). For
   * private rooms (`wallet:*`) the JWT-derived `client.data.wallet`
   * MUST equal the room's pubkey or the join is rejected.
   *
   * Idempotent: joining the same room twice is a no-op (Socket.IO's
   * underlying adapter de-dupes by socket id + room).
   */
  @SubscribeMessage('subscribe')
  handleSubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: SubscribeBody): Ack {
    const raw = body?.room;
    if (typeof raw !== 'string') {
      this.metrics.realtimeSubscriptions.inc({ room_type: 'unknown', outcome: 'rejected' });
      return { ok: false, error: 'unknown_room' };
    }
    const parsed = parseRoom(raw);
    if (!parsed) {
      this.metrics.realtimeSubscriptions.inc({ room_type: 'unknown', outcome: 'rejected' });
      return { ok: false, error: 'unknown_room' };
    }

    if (parsed.type === 'wallet') {
      const wallet = client.data?.wallet as string | null | undefined;
      if (!wallet) {
        this.metrics.realtimeSubscriptions.inc({ room_type: 'wallet', outcome: 'rejected' });
        return { ok: false, error: 'auth_required' };
      }
      if (wallet !== parsed.pubkey) {
        this.metrics.realtimeSubscriptions.inc({ room_type: 'wallet', outcome: 'rejected' });
        return { ok: false, error: 'auth_mismatch' };
      }
    }

    void client.join(raw);
    this.metrics.realtimeSubscriptions.inc({ room_type: parsed.type, outcome: 'accepted' });
    return { ok: true };
  }

  /**
   * Client-driven leave. Symmetrical with `subscribe`: format is validated
   * but no auth check is required — leaving a room you're not in is a
   * no-op at the adapter level.
   */
  @SubscribeMessage('unsubscribe')
  handleUnsubscribe(@ConnectedSocket() client: Socket, @MessageBody() body: SubscribeBody): Ack {
    const raw = body?.room;
    if (typeof raw !== 'string') {
      return { ok: false, error: 'unknown_room' };
    }
    const parsed = parseRoom(raw);
    if (!parsed) {
      return { ok: false, error: 'unknown_room' };
    }
    void client.leave(raw);
    return { ok: true };
  }
}

/**
 * Resolves the source IP for a Socket.IO client.
 *
 * In production we trust `x-forwarded-for` (Cloudflared sets it after
 * stripping any client-supplied value). In dev / staging we ignore the
 * header and use the direct connection address — otherwise an attacker on
 * the local network could spoof XFF to bypass the per-IP throttle.
 *
 * Sanitisation: strip the `::ffff:` IPv4-mapped-IPv6 prefix Node.js
 * surfaces on dual-stack listeners so `192.168.1.1` and `::ffff:192.168.1.1`
 * don't end up as separate keys in Redis.
 */
function resolveClientIp(client: Socket): string {
  let raw: string | undefined;
  if (IP_HEADER_TRUSTED) {
    const xff = client.handshake.headers['x-forwarded-for'];
    const flat = Array.isArray(xff) ? xff[0] : xff;
    if (typeof flat === 'string' && flat.length > 0) {
      // XFF can carry a chain `client, proxy1, proxy2`; the leftmost is
      // the originating client.
      raw = flat.split(',')[0]?.trim();
    }
  }
  if (!raw) {
    raw = client.handshake.address;
  }
  if (!raw) return 'unknown';
  // Normalise IPv4-mapped-IPv6 (`::ffff:1.2.3.4` → `1.2.3.4`).
  if (raw.startsWith('::ffff:')) {
    return raw.slice('::ffff:'.length);
  }
  return raw;
}
