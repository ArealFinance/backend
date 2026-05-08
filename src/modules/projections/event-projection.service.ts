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
 * Emit payload returned from `projectInTx` for the six wallet-keyed event
 * kinds. The indexer consumer collects these and fans them out to the
 * realtime gateway AFTER the wrapping TX commits — never inside, so a
 * rollback can't leak a transient emit to subscribers.
 *
 * `RevenueDistributed` is wallet-less (fans out across N OT-holders inside
 * one instruction) so it returns null. Unknown / unprojected events also
 * return null.
 */
export interface ProjectionEmitPayload {
  wallet: string;
  kind: 'claim' | 'swap' | 'add_lp' | 'remove_lp' | 'zap_lp' | 'mint_rwt';
  signature: string;
  /** Unix seconds; 0 if RPC withheld block_time and we fell back to wall clock. */
  blockTime: number;
}

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
  ): Promise<ProjectionEmitPayload | null> {
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
          return buildEmit('claim', input);
        case 'SwapExecuted':
          await this.swap.project(manager, input);
          return buildEmit('swap', input);
        case 'LiquidityAdded':
          await this.liquidity.project(manager, input);
          return buildEmit('add_lp', input);
        case 'LiquidityRemoved':
          await this.liquidity.project(manager, input);
          return buildEmit('remove_lp', input);
        case 'ZapLiquidityExecuted':
          await this.liquidity.project(manager, input);
          return buildEmit('zap_lp', input);
        case 'RwtMinted':
          await this.liquidity.project(manager, input);
          return buildEmit('mint_rwt', input);
        case 'RevenueDistributed':
          await this.revenue.project(manager, input);
          // Wallet-less event — no emit (fanout is per-OT-holder, surfaces
          // via per-wallet RewardsClaimed events on subsequent claims).
          return null;
        default:
          // Silent skip — not every persisted event is projected.
          return null;
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

/**
 * Read the wallet from the projector input and build the emit payload.
 *
 * Different event shapes use different wallet field names (`provider`,
 * `user`, `claimant`, `swapper`) — the persister normalises these into
 * `data` but the field name still varies by event. We try each in
 * order and fall back to `null` if the event has no wallet (which would
 * mean the projection layer let an unprojectable event through — the
 * caller treats this as "no emit" so we don't leak a transaction-indexed
 * notification with a malformed wallet).
 */
function buildEmit(
  kind: ProjectionEmitPayload['kind'],
  input: ProjectInput,
): ProjectionEmitPayload | null {
  const candidates = ['provider', 'user', 'claimant', 'swapper', 'wallet'];
  let wallet: string | null = null;
  for (const k of candidates) {
    const v = input.data[k];
    if (typeof v === 'string' && v.length > 0) {
      wallet = v;
      break;
    }
  }
  if (!wallet) return null;

  // block_time is a Date in PersistMeta; the realtime payload surfaces it
  // as unix seconds (parallel to the SDK's portfolio-snapshot convention).
  const blockTime = Math.floor(input.meta.blockTime.getTime() / 1000);
  return {
    wallet,
    kind,
    signature: input.meta.signature,
    blockTime,
  };
}
