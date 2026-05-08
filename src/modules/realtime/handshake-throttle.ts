import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// `ioredis` is CommonJS; under our `module: NodeNext` setup the default
// import is the namespace object, not the constructor. Use the named
// `Redis` re-export — it IS the class — for both the value and the type.
import { Redis } from 'ioredis';

/**
 * Default rate-limit envelope: 20 connect attempts per 60s rolling window
 * per source IP. Overridable via env vars
 * `REALTIME_HANDSHAKE_RATE_LIMIT_COUNT` and
 * `REALTIME_HANDSHAKE_RATE_LIMIT_WINDOW_SEC`.
 *
 * Why these defaults: a legitimate UI client opens 1 socket per tab and
 * Socket.IO's reconnect policy backs off to 5s — even on a flapping link
 * that's well below 20/min. An attacker burning CPU on the JWT verify
 * path needs hundreds of attempts per minute to be material; the cap is
 * comfortably above the legitimate ceiling and well below the attack floor.
 */
const DEFAULT_LIMIT_COUNT = 20;
const DEFAULT_LIMIT_WINDOW_SEC = 60;

interface RateLimit {
  count: number;
  windowSec: number;
}

export type ThrottleOutcome = { ok: true } | { ok: false; retryAfterSec: number };

/**
 * Per-IP rate limiter for Socket.IO handshakes (Phase 12.3.1 follow-up).
 *
 * Why this exists: the `/realtime` gateway runs `jwt.verifyAsync`
 * (HMAC-SHA256) on every handshake. The global REST `ThrottlerGuard`
 * does NOT cover WebSocket connections, so without this gate an attacker
 * can open many sockets with bogus `Authorization: Bearer ...` and burn
 * CPU. We cap connect attempts per IP using a Redis sliding-window
 * counter (sorted-set with score = unix-ms epoch).
 *
 * Why a separate Redis client (and not the Socket.IO redis-adapter):
 * the adapter's pub/sub connections shouldn't be multiplexed for
 * counters — ioredis subscribers can't issue regular commands. Different
 * concerns, separate clients.
 *
 * Fail-open posture: a Redis blip MUST NOT lock all users out. Errors
 * are logged and the throttle returns `ok:true`. Availability beats
 * a transient anti-DoS gap.
 */
@Injectable()
export class HandshakeThrottleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HandshakeThrottleService.name);
  private readonly client: Redis;
  private readonly limit: RateLimit;

  constructor(config: ConfigService) {
    const url = config.get<string>('redis.url') ?? 'redis://127.0.0.1:6379';
    this.client = new Redis(url, {
      // The throttle is on the connection hot path; tolerate a single
      // disconnect during a redeploy but stop retrying forever after that
      // so an unreachable Redis surfaces as a fail-open warning instead
      // of hanging the handshake.
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    this.client.on('error', (err: Error) => {
      this.logger.warn(`handshake-throttle redis error: ${err.message}`);
    });
    this.limit = readLimitFromEnv();
  }

  onModuleInit(): void {
    this.logger.log(
      `handshake throttle armed: ${this.limit.count}/${this.limit.windowSec}s per IP`,
    );
  }

  /**
   * Records a connect attempt for `ip` and returns whether the attempt is
   * within the configured envelope. The check + record is performed
   * atomically via a pipeline so two concurrent connects from the same IP
   * can't both squeeze past the cap.
   *
   * Algorithm (Redis sorted-set sliding window):
   *   1. `ZREMRANGEBYSCORE key 0 (now - windowMs)` — evict expired members.
   *   2. `ZCARD key` — count remaining (inside-window) members.
   *   3. If count >= cap → reject; compute `retryAfterSec` from the
   *      oldest member's score so the client knows when to retry.
   *   4. Else → `ZADD key now <unique-member>` + `EXPIRE key (windowSec*2)`.
   *
   * The unique member is `now-random` to avoid `ZADD` no-op when two
   * connects arrive in the same millisecond.
   */
  async checkAndRecord(ip: string): Promise<ThrottleOutcome> {
    const key = `realtime:handshake:${ip}`;
    const now = Date.now();
    const windowMs = this.limit.windowSec * 1000;
    const cutoff = now - windowMs;

    try {
      // Pipeline: evict + count first; we need the post-eviction count to
      // decide whether to admit OR look up the oldest surviving member
      // (for `retryAfterSec`).
      const evictThenCount = await this.client
        .multi()
        .zremrangebyscore(key, 0, cutoff)
        .zcard(key)
        .exec();

      // ioredis returns null on whole-pipeline failure (e.g. connection
      // dropped mid-flight). Treat it like a thrown error — fail open.
      if (!evictThenCount) {
        return { ok: true };
      }
      const cardResult = evictThenCount[1];
      const count = (cardResult?.[1] as number | null) ?? 0;

      if (count >= this.limit.count) {
        // At cap. Look up the oldest surviving entry to compute when the
        // window slides forward enough to admit a new attempt. ioredis
        // returns `[member, score, member, score, ...]` for ZRANGE WITHSCORES.
        const oldest = await this.client.zrange(key, 0, 0, 'WITHSCORES');
        const oldestMs = oldest.length >= 2 ? Number(oldest[1]) : now;
        const retryAfterMs = oldestMs + windowMs - now;
        const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000));
        return { ok: false, retryAfterSec };
      }

      // Admitted — record the attempt. Member uniqueness via `now-rand` so
      // ZADD never no-ops on same-ms arrivals.
      const member = `${now}-${Math.random().toString(36).slice(2, 10)}`;
      await this.client
        .multi()
        .zadd(key, now, member)
        .expire(key, this.limit.windowSec * 2)
        .exec();

      return { ok: true };
    } catch (err) {
      // Fail OPEN — a Redis blip must not lock all users out. Log a warning
      // for ops visibility (sustained warnings = real problem), and let
      // the connection through. The realtimeHandshakeRejected counter
      // separately distinguishes rate-limit rejections from these errors
      // via its `reason` label.
      this.logger.warn(
        `handshake-throttle fail-open for ip=${ip}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { ok: true };
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      // Already disconnected — safe to ignore on shutdown.
    }
  }
}

/**
 * Reads the `REALTIME_HANDSHAKE_RATE_LIMIT_COUNT` and
 * `REALTIME_HANDSHAKE_RATE_LIMIT_WINDOW_SEC` env vars. Anything missing or
 * non-positive falls back to the safe defaults (20/60s) — we'd rather ship
 * the defaults than refuse to boot on a typo'd env file.
 */
function readLimitFromEnv(): RateLimit {
  const count = readPositiveIntEnv(
    process.env.REALTIME_HANDSHAKE_RATE_LIMIT_COUNT,
    DEFAULT_LIMIT_COUNT,
  );
  const windowSec = readPositiveIntEnv(
    process.env.REALTIME_HANDSHAKE_RATE_LIMIT_WINDOW_SEC,
    DEFAULT_LIMIT_WINDOW_SEC,
  );
  return { count, windowSec };
}

function readPositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
