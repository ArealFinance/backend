import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import configuration from './config/configuration.js';
import { Event } from './entities/event.entity.js';
import { RefreshToken } from './entities/refresh-token.entity.js';
import { User } from './entities/user.entity.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IndexerModule } from './modules/indexer/indexer.module.js';
import { MetricsModule } from './modules/metrics/metrics.module.js';

/**
 * Root application module.
 *
 * Composition rules (Areal):
 *   - Feature modules under `modules/<feature>/`.
 *   - All entities listed once here in `TypeOrmModule.forRootAsync` so the
 *     CLI data source and the runtime app stay in sync. Adding an entity
 *     means: register here AND in the feature module's `forFeature([...])`.
 *   - Bull and Schedule register at root so workers / cron run inside the
 *     same process; production may split into a worker container later
 *     (Phase 12.2+).
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env.local', '.env'],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 'postgres' as const,
        url: config.get<string>('database.url'),
        schema: config.get<string>('database.schema'),
        synchronize: config.get<boolean>('database.synchronize'),
        logging: config.get<boolean>('database.logging'),
        entities: [Event, User, RefreshToken],
        migrations: [],
        ssl:
          config.get<string>('environment') === 'production'
            ? { rejectUnauthorized: false }
            : false,
      }),
    }),
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('redis.url') ?? 'redis://127.0.0.1:6379';
        return { redis: url };
      },
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 60, // 60 req / min per IP — tighten per route as needed.
      },
    ]),
    AuthModule,
    IndexerModule,
    HealthModule,
    MetricsModule,
  ],
})
export class AppModule {}
