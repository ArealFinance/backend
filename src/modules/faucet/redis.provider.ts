import { ConfigService } from '@nestjs/config';
import { Logger, type FactoryProvider } from '@nestjs/common';
// `ioredis` is CommonJS; under our `module: NodeNext` setup the default
// import is the namespace object, not the constructor. Use the named
// `Redis` re-export — it IS the class — for both the value and the type.
import { Redis } from 'ioredis';

/**
 * DI token for the faucet-scoped Redis client. Kept module-local — the
 * faucet only needs Redis for two narrow concerns (per-wallet 24h
 * rate-limit + 30s single-flight lock) and we'd rather an unrelated
 * module not accidentally evict its keys via shared connection state.
 */
export const FAUCET_REDIS = Symbol('FAUCET_REDIS');

/**
 * Factory provider that builds a single ioredis client from the same
 * `REDIS_URL` the BullModule consumes. Mirrors the auth module pattern
 * — lazyConnect: false so a misconfig surfaces at boot, not on the
 * first claim attempt.
 */
export const faucetRedisProvider: FactoryProvider<Redis> = {
  provide: FAUCET_REDIS,
  inject: [ConfigService],
  useFactory: (config: ConfigService) => {
    const logger = new Logger('FaucetRedis');
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
