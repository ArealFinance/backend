import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { DailyPoolAggregate } from '../../entities/daily-pool-aggregate.entity.js';
import { PoolSnapshot } from '../../entities/pool-snapshot.entity.js';
import { ProtocolSummary } from '../../entities/protocol-summary.entity.js';
import { Transaction } from '../../entities/transaction.entity.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { MarketsAggregatorBootstrap } from './markets-aggregator.bootstrap.js';
import {
  MARKETS_AGGREGATOR_QUEUE,
  MarketsAggregatorConsumer,
} from './markets-aggregator.consumer.js';
import { MarketsAggregatorService } from './markets-aggregator.service.js';
import { MarketsController } from './markets.controller.js';
import { MarketsService } from './markets.service.js';
import { HoldersService } from './holders/holders.service.js';
import { marketsRedisProvider } from './holders/markets-redis.provider.js';

/**
 * Phase 12.3.1 markets module.
 *
 * Composition:
 *   - REST: `MarketsController` + `MarketsService` (read-only).
 *   - Aggregator: cron jobs in `MarketsAggregatorService`, queue handlers
 *     in `MarketsAggregatorConsumer`, repeatable registration in
 *     `MarketsAggregatorBootstrap`.
 *   - Realtime emit: `RealtimeModule` (imported, not re-provided).
 *   - Solana RPC: `SolanaConnectionModule` is registered as `@Global` at
 *     the root, so `SOLANA_CONNECTION` is available without explicit import.
 *
 * `Transaction` is registered here too because the aggregator queries it
 * for 24h volume / tx_count rollups; same entity is also registered in
 * `ProjectionsModule` (TypeOrmModule.forFeature is repository-scope so
 * dual-registration is fine).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([PoolSnapshot, DailyPoolAggregate, ProtocolSummary, Transaction]),
    BullModule.registerQueue({ name: MARKETS_AGGREGATOR_QUEUE }),
    RealtimeModule,
  ],
  controllers: [MarketsController],
  providers: [
    MarketsService,
    MarketsAggregatorService,
    MarketsAggregatorConsumer,
    MarketsAggregatorBootstrap,
    HoldersService,
    marketsRedisProvider,
  ],
  exports: [MarketsService],
})
export class MarketsModule {}
