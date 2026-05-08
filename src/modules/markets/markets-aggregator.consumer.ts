import { Process, Processor } from '@nestjs/bull';
import { Logger } from '@nestjs/common';

import { MarketsAggregatorService } from './markets-aggregator.service.js';

export const MARKETS_AGGREGATOR_QUEUE = 'markets-aggregator';
export const JOB_NAMES = {
  snapshot60s: 'snapshot60s',
  rollup5m: 'rollup5m',
  summary30s: 'summary30s',
} as const;

/**
 * Bull consumer for the markets-aggregator queue.
 *
 * Three jobs, one handler each, `concurrency: 1` per `@Process({ concurrency })`.
 * The advisory-lock inside the service provides multi-replica safety, but
 * concurrency=1 inside a single replica avoids overlapping the same job
 * with itself when a previous run takes longer than the cron cadence
 * (e.g. snapshot60s overruns past 60s on a slow RPC).
 *
 * Failure handling: errors propagate. Bull's job options (`removeOnComplete`,
 * `removeOnFail` set at producer time in `markets-aggregator.bootstrap.ts`)
 * trim the queue history; the failure path raises an alert via the
 * `aggregator_rpc_failures_total` counter that the service increments
 * for known RPC failure modes.
 */
@Processor(MARKETS_AGGREGATOR_QUEUE)
export class MarketsAggregatorConsumer {
  private readonly logger = new Logger(MarketsAggregatorConsumer.name);

  constructor(private readonly service: MarketsAggregatorService) {}

  @Process({ name: JOB_NAMES.snapshot60s, concurrency: 1 })
  async handleSnapshot(): Promise<void> {
    await this.service.snapshotPools60s();
  }

  @Process({ name: JOB_NAMES.rollup5m, concurrency: 1 })
  async handleRollup(): Promise<void> {
    await this.service.rollupDailyAggregates5m();
  }

  @Process({ name: JOB_NAMES.summary30s, concurrency: 1 })
  async handleSummary(): Promise<void> {
    await this.service.writeProtocolSummary30s();
  }
}
