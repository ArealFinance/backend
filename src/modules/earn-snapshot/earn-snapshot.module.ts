import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { EarnSnapshot } from '../../entities/earn-snapshot.entity.js';
import { EarnController } from './earn.controller.js';
import { EarnSnapshotService } from './earn-snapshot.service.js';
import { EarnStatsService } from './earn-stats.service.js';

/**
 * Earn snapshot module — ALWAYS registered in AppModule.
 *
 * Composition:
 *   - `EarnSnapshotService` — 5-min `@Cron` that reads EarnConfig +
 *     StakingConfig + mint supplies on-chain and appends an `earn_snapshots`
 *     row. READ-only against chain → cluster-agnostic, prod-grade.
 *   - `EarnStatsService` — read-side that assembles `GET /earn/stats`
 *     (Book NAV, stRWT rate, TVL, honest APY, downsampled history).
 *   - `EarnController` — the public `/earn/stats` route (no auth, throttled).
 *
 * Solana RPC: `SOLANA_CONNECTION` is provided `@Global` at the root, so no
 * explicit import of the connection module is needed.
 */
@Module({
  imports: [TypeOrmModule.forFeature([EarnSnapshot])],
  controllers: [EarnController],
  providers: [EarnSnapshotService, EarnStatsService],
  exports: [EarnSnapshotService],
})
export class EarnSnapshotModule {}
