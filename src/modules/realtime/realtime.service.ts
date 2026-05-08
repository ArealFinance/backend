import { Injectable, Logger } from '@nestjs/common';

import { MetricsService } from '../metrics/metrics.service.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { PROTOCOL_ROOM, poolRoom, walletRoom } from './rooms.js';

/**
 * Wire payloads emitted on the `/realtime` namespace.
 *
 * SDK contract — also documented in `backend/docs/REALTIME-PROTOCOL.md`
 * which the 12.3.2 SDK implementer reads. Adding/changing a field here
 * requires updating the docs file in the same commit.
 *
 * Numeric precision: u64 fields are decimal STRINGS (lossless past 2^53);
 * USD-denominated fields are JS numbers (always < 2^53 in the realistic
 * range). Pubkeys are base58 strings.
 */
export interface PoolSnapshotEmit {
  pool: string;
  blockTime: number;
  tvlA: string;
  tvlB: string;
  tvlUsd: number | null;
  reserveA: string;
  reserveB: string;
  feeGrowthA: string;
  feeGrowthB: string;
  lpSupply: string;
}

export interface ProtocolSummaryTickEmit {
  totalTvlUsd: number;
  volume24hUsd: number;
  txCount24h: number;
  activeWallets24h: number;
  poolCount: number;
  distributorCount: number;
  blockTime: number;
}

export interface TransactionIndexedEmit {
  wallet: string;
  /** 'claim' | 'swap' | 'add_lp' | 'remove_lp' | 'zap_lp' | 'mint_rwt' */
  kind: string;
  signature: string;
  /** Unix seconds; 0 if RPC withheld block_time. */
  blockTime: number;
}

/**
 * Thin emit-only facade in front of the Socket.IO server.
 *
 * Why a separate service: callers (`MarketsAggregatorService`,
 * `IndexerConsumer`) shouldn't need to know about Socket.IO room naming
 * or the gateway's `server` instance. Centralising the room key + the
 * metrics increment in one place keeps the hot-path side effects
 * uniform and makes it impossible to forget the metric label.
 *
 * All methods are SYNCHRONOUS — Socket.IO's `emit` is fire-and-forget;
 * we return `void` so callers don't accidentally await on a no-op
 * promise that would otherwise be a microtask hazard inside transactions.
 */
@Injectable()
export class RealtimeService {
  private readonly logger = new Logger(RealtimeService.name);

  constructor(
    private readonly gateway: RealtimeGateway,
    private readonly metrics: MetricsService,
  ) {}

  emitPoolSnapshot(payload: PoolSnapshotEmit): void {
    const server = this.gateway.server;
    if (!server) {
      // The gateway hasn't been initialised yet (rare — happens during
      // graceful shutdown when a cron job races the `OnModuleDestroy`
      // teardown). Safer to drop the emit than to throw inside a TX.
      return;
    }
    server.to(poolRoom(payload.pool)).emit('pool_snapshot', payload);
    this.metrics.realtimeEmits.inc({ channel: 'pool_snapshot' });
  }

  emitProtocolSummaryTick(payload: ProtocolSummaryTickEmit): void {
    const server = this.gateway.server;
    if (!server) return;
    server.to(PROTOCOL_ROOM).emit('protocol_summary_tick', payload);
    this.metrics.realtimeEmits.inc({ channel: 'protocol_summary_tick' });
  }

  emitTransactionIndexed(payload: TransactionIndexedEmit): void {
    const server = this.gateway.server;
    if (!server) return;
    server.to(walletRoom(payload.wallet)).emit('transaction_indexed', payload);
    this.metrics.realtimeEmits.inc({ channel: 'transaction_indexed' });
  }
}
