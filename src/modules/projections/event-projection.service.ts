import { Injectable, Logger } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import type { DecodedEvent } from '../indexer/decoder.service.js';
import type { PersistMeta } from '../indexer/persister.service.js';
import { MetricsService } from '../metrics/metrics.service.js';
import { ClaimProjector } from './projectors/claim.projector.js';
import { LiquidityProjector } from './projectors/liquidity.projector.js';
import { RevenueProjector } from './projectors/revenue.projector.js';
import { SwapProjector } from './projectors/swap.projector.js';
import type { ProjectInput } from './projectors/types.js';

/**
 * Stream-projection dispatcher.
 *
 * Called once per decoded event from the indexer consumer, inside the SAME
 * Postgres transaction that persisted the raw row. Either both writes (raw
 * `events` + projection rows) commit, or both roll back — there is no
 * window where an event sits in `events` without its projection.
 *
 * Routing is by IDL event name. Unknown event names are a SILENT skip (we
 * persist 60+ event types but only project the ones that surface in the UI;
 * adding more projections later is a strict superset).
 *
 * Errors propagate. The wrapping transaction in the indexer consumer rolls
 * back on throw, the Bull job retries via the producer's backoff config,
 * and the `projection_errors_total` metric increments labelled with the
 * event name for ops visibility.
 */
@Injectable()
export class EventProjectionService {
  private readonly logger = new Logger(EventProjectionService.name);

  constructor(
    private readonly claim: ClaimProjector,
    private readonly swap: SwapProjector,
    private readonly liquidity: LiquidityProjector,
    private readonly revenue: RevenueProjector,
    private readonly metrics: MetricsService,
  ) {}

  async projectInTx(
    manager: EntityManager,
    decoded: DecodedEvent,
    meta: PersistMeta,
  ): Promise<void> {
    const eventName = decoded.eventName;
    const input: ProjectInput = {
      data: decoded.data as Record<string, unknown>,
      eventName,
      meta,
    };

    const stop = this.metrics.projectionLatency.startTimer();
    try {
      switch (eventName) {
        case 'RewardsClaimed':
          await this.claim.project(manager, input);
          break;
        case 'SwapExecuted':
          await this.swap.project(manager, input);
          break;
        case 'LiquidityAdded':
        case 'LiquidityRemoved':
        case 'ZapLiquidityExecuted':
        case 'RwtMinted':
          await this.liquidity.project(manager, input);
          break;
        case 'RevenueDistributed':
          await this.revenue.project(manager, input);
          break;
        default:
          // Silent skip — not every persisted event is projected.
          return;
      }
    } catch (err) {
      this.metrics.projectionErrors.inc({ event_name: eventName });
      this.logger.error(
        `projector failed for ${eventName} ${meta.signature}#${meta.logIndex}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    } finally {
      stop();
    }
  }
}
