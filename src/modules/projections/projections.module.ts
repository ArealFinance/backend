import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClaimHistory } from '../../entities/claim-history.entity.js';
import { LpPositionHistory } from '../../entities/lp-position-history.entity.js';
import { RevenueDistribution } from '../../entities/revenue-distribution.entity.js';
import { Transaction } from '../../entities/transaction.entity.js';
import { EventProjectionService } from './event-projection.service.js';
import { ClaimProjector } from './projectors/claim.projector.js';
import { LiquidityProjector } from './projectors/liquidity.projector.js';
import { RevenueProjector } from './projectors/revenue.projector.js';
import { SwapProjector } from './projectors/swap.projector.js';

/**
 * Phase 12.2.1 projection layer.
 *
 * Provides `EventProjectionService` (the dispatcher used inline by the
 * indexer consumer) and the four per-shape projectors. Entities are
 * registered here via `forFeature` so the projectors can `getRepository()`
 * off the per-request EntityManager.
 *
 * MetricsService is global (`@Global()` on `MetricsModule`) so we don't
 * re-import it explicitly.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Transaction, ClaimHistory, RevenueDistribution, LpPositionHistory]),
  ],
  providers: [
    EventProjectionService,
    ClaimProjector,
    SwapProjector,
    LiquidityProjector,
    RevenueProjector,
  ],
  exports: [EventProjectionService],
})
export class ProjectionsModule {}
