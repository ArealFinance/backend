import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { TypeOrmModule } from '@nestjs/typeorm';

import configuration from './config/configuration.js';
import { ClaimHistory } from './entities/claim-history.entity.js';
import { DailyPoolAggregate } from './entities/daily-pool-aggregate.entity.js';
import { Event } from './entities/event.entity.js';
import { LpPositionHistory } from './entities/lp-position-history.entity.js';
import { PoolSnapshot } from './entities/pool-snapshot.entity.js';
import { ProtocolSummary } from './entities/protocol-summary.entity.js';
import { RefreshToken } from './entities/refresh-token.entity.js';
import { RevenueDistribution } from './entities/revenue-distribution.entity.js';
import { Transaction } from './entities/transaction.entity.js';
import { User } from './entities/user.entity.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IndexerModule } from './modules/indexer/indexer.module.js';
import { MetricsModule } from './modules/metrics/metrics.module.js';
import { PortfolioModule } from './modules/portfolio/portfolio.module.js';
import { MarketsModule } from './modules/markets/markets.module.js';
import { ProjectionsModule } from './modules/projections/projections.module.js';
import { RealtimeModule } from './modules/realtime/realtime.module.js';
import { TransactionsModule } from './modules/transactions/transactions.module.js';

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
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('database.url') ?? '';
        // Only opt into TLS when the connection string explicitly requests it
        // via `sslmode=require`. Self-hosted intra-cluster Docker deployments
        // ride the bridge network plaintext (`sslmode=disable`); managed
        // Postgres / multi-host setups should set `sslmode=require` and the
        // node-postgres driver picks up the CA from the system trust store.
        const wantsSsl = /[?&]sslmode=require\b/.test(url);
        return {
          type: 'postgres' as const,
          url,
          schema: config.get<string>('database.schema'),
          synchronize: config.get<boolean>('database.synchronize'),
          logging: config.get<boolean>('database.logging'),
          entities: [
            Event,
            User,
            RefreshToken,
            Transaction,
            ClaimHistory,
            RevenueDistribution,
            LpPositionHistory,
            PoolSnapshot,
            DailyPoolAggregate,
            ProtocolSummary,
          ],
          migrations: [],
          ssl: wantsSsl ? { rejectUnauthorized: false } : false,
        };
      },
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
    ProjectionsModule,
    TransactionsModule,
    PortfolioModule,
    RealtimeModule,
    MarketsModule,
  ],
  providers: [
    // Apply ThrottlerGuard globally so every controller route gets rate-limited
    // by the default policy (60 req/min/IP). Routes that need a tighter or
    // looser limit override per-handler via `@Throttle({...})` — see auth.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
