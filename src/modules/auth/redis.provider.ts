import { ConfigService } from '@nestjs/config';
import { Logger, type FactoryProvider } from '@nestjs/common';
// `ioredis` is CommonJS; under our `module: NodeNext` setup the default
// import is the namespace object, not the constructor. Use the named
// `Redis` re-export — it IS the class — for both the value and the type.
import { Redis } from 'ioredis';

/**
 * DI token for the auth-scoped Redis client. Kept module-local so the auth
 * service is the only thing that resolves it; future modules that need
 * caching should mint their own client (or, better, a dedicated CacheModule
 * down the line) rather than reusing this one — keeps the connection
 * lifecycle predictable when modules are loaded/unloaded in tests.
 */
export const AUTH_REDIS = Symbol('AUTH_REDIS');

/**
 * Factory provider that builds a single ioredis client from the same
 * `REDIS_URL` the BullModule consumes. Reuses the well-known connection
 * string so operators have one knob to turn for dev / staging / prod.
 *
 * `lazyConnect: false` because the auth flow is on the request hot path —
 * we'd rather fail loudly at boot than time out on the first login attempt
 * after a deploy.
 */
export const authRedisProvider: FactoryProvider<Redis> = {
  provide: AUTH_REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const logger = new Logger('AuthRedis');
    const url = config.get<string>('redis.url') ?? 'redis://127.0.0.1:6379';
    const client = new Redis(url, {
      // Per-wallet rate limiting is on the request hot path: every failed
      // login probes `INCR auth_failures:<wallet>`. We tolerate a single
      // disconnect during a redeploy but stop retrying forever after that
      // so an unreachable Redis surfaces as a 500 instead of a hanging
      // request.
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });
    client.on('error', (err: Error) => {
      logger.error(`Redis error: ${err.message}`);
    });
    return client;
  },
};
