import { ConfigService } from '@nestjs/config';
import { Logger, type FactoryProvider } from '@nestjs/common';
// `ioredis` is CommonJS; under our `module: NodeNext` setup the default
// import is the namespace object, not the constructor. Use the named
// `Redis` re-export — it IS the class — for both the value and the type.
// Mirrors `auth/redis.provider.ts` deliberately.
import { Redis } from 'ioredis';

/**
 * DI token for the markets-scoped Redis client. Module-local on purpose:
 * the holders endpoint is the only consumer today, and keeping a per-module
 * client makes the connection lifecycle predictable when modules are loaded /
 * unloaded in tests. Future cache-only modules should mint their own client
 * (or, eventually, a shared CacheModule) rather than reusing this one.
 */
export const MARKETS_REDIS = Symbol('MARKETS_REDIS');

/**
 * Factory provider that builds a single ioredis client from the same
 * `REDIS_URL` BullModule consumes — operators have one knob to turn for
 * dev / staging / prod.
 *
 * `lazyConnect: false` so an unreachable Redis surfaces at boot rather
 * than as a hung first request after a deploy. `maxRetriesPerRequest: 3`
 * tolerates a single disconnect during a redeploy then fails fast.
 */
export const marketsRedisProvider: FactoryProvider<Redis> = {
  provide: MARKETS_REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const logger = new Logger('MarketsRedis');
    const url = config.get<string>('redis.url') ?? 'redis://127.0.0.1:6379';
    const client = new Redis(url, {
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
