import { Logger, type INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { ServerOptions } from 'socket.io';

import { REALTIME_ALLOWED_ORIGINS } from './realtime.gateway.js';

/**
 * Socket.IO adapter that fan-outs emits across Nest replicas via Redis.
 *
 * Without this adapter, an emit on instance A only reaches sockets
 * connected to instance A. With the Redis adapter, every node subscribes
 * to a shared pub/sub channel and re-broadcasts the emit locally — so a
 * cron firing on the worker container reaches a UI socket connected to
 * the API container.
 *
 * Single-node deployments still benefit from running through this adapter
 * (it's a no-op extra Redis trip but keeps the code path identical to
 * production). For production we'd add `key: 'areal-realtime'` to
 * namespace the pub/sub channel — defaults to `socket.io` which is fine
 * given our dedicated Redis DB index.
 */
export class RealtimeRedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RealtimeRedisIoAdapter.name);
  // The createAdapter callable's return type isn't exported by socket.io,
  // so we use the inferred return type of `createAdapter(...)` to keep
  // it as a closed type without leaking the third-party shape outward.
  private adapterCtor: ReturnType<typeof createAdapter> | null = null;
  private pub: Redis | null = null;
  private sub: Redis | null = null;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  /**
   * Connects to Redis and prepares the adapter constructor. Call before
   * `app.useWebSocketAdapter(this)` in `main.ts`. Errors are logged but
   * not re-thrown — without the adapter the gateway falls back to
   * single-node mode, which is preferable to a hard boot failure.
   */
  async connectToRedis(redisUrl: string): Promise<void> {
    try {
      const pub = new Redis(redisUrl, {
        // The default `lazyConnect: false` is fine; we WANT the connection
        // to fail loudly at boot if Redis is unreachable. The adapter
        // sub-channels also subscribe immediately so latency is one round
        // trip per emit — measured at < 1 ms intra-DC.
        maxRetriesPerRequest: 3,
      });
      const sub = pub.duplicate();
      this.pub = pub;
      this.sub = sub;
      this.adapterCtor = createAdapter(pub, sub);
    } catch (err) {
      this.logger.error(
        `redis adapter init failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      this.adapterCtor = null;
    }
  }

  createIOServer(port: number, options?: ServerOptions): unknown {
    // Force-apply the same CORS allow-list as the REST app: NestJS calls
    // this with `options` containing the gateway-decorator config, but we
    // override `cors.origin` defensively in case a future gateway change
    // omits it. `transports` defaults to `['polling', 'websocket']`; we
    // restrict to websocket-only to avoid sticky-session pitfalls behind
    // Cloudflare (long-poll requests need session affinity to land on
    // the same upstream).
    const merged: Partial<ServerOptions> = {
      ...options,
      cors: { origin: REALTIME_ALLOWED_ORIGINS, credentials: true },
      transports: ['websocket'],
    };
    const server = super.createIOServer(port, merged as ServerOptions) as {
      adapter: (factory: ReturnType<typeof createAdapter>) => unknown;
    };
    if (this.adapterCtor) {
      server.adapter(this.adapterCtor);
    }
    return server;
  }

  /**
   * Releases the Redis pub/sub connections. Call from `app.close()`
   * shutdown hook so the process can exit cleanly in dev (`Ctrl-C`).
   */
  async disposeRedis(): Promise<void> {
    await Promise.allSettled([this.pub?.quit(), this.sub?.quit()]);
    this.pub = null;
    this.sub = null;
    this.adapterCtor = null;
  }
}
