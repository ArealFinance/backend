import { InjectQueue } from '@nestjs/bull';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Queue } from 'bull';

import { JOB_NAMES, MARKETS_AGGREGATOR_QUEUE } from './markets-aggregator.consumer.js';

/**
 * Repeatable-job cadences (ms). Three independent cron tracks, each
 * registered as a Bull "repeatable" so the queue persists the schedule
 * across restarts.
 */
const SCHEDULE_MS = {
  snapshot60s: 60_000,
  rollup5m: 300_000,
  summary30s: 30_000,
} as const;

const STANDARD_JOB_OPTS = {
  removeOnComplete: 100,
  removeOnFail: 50,
} as const;

/**
 * Boot-time setup for the markets-aggregator repeatables.
 *
 * On every process boot we:
 *   1. Read the current set of repeatables from Bull.
 *   2. Remove any that don't match the current SCHEDULE_MS values
 *      (cleans up stale entries from older cadences when we tune them).
 *   3. Register the three current repeatables. Bull dedupes by `(name, repeat)`
 *      so re-adding an unchanged schedule is a no-op.
 *
 * Why this lives in `OnModuleInit` rather than the consumer:
 *   The consumer registers `@Process` handlers but doesn't know about the
 *   producer side (cron registration). Splitting them lets the worker
 *   container run only the consumer (without re-adding repeatables).
 *   For Phase 12.3.1 we run both in-process — production may split later.
 */
@Injectable()
export class MarketsAggregatorBootstrap implements OnModuleInit {
  private readonly logger = new Logger(MarketsAggregatorBootstrap.name);

  constructor(@InjectQueue(MARKETS_AGGREGATOR_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.cleanStaleRepeatables();
    await this.registerRepeatables();
  }

  /**
   * Remove repeatables whose `every` ms differs from the current schedule.
   * Bull's `removeRepeatableByKey` is idempotent — passing a stale key from
   * a previous boot is also a no-op.
   */
  private async cleanStaleRepeatables(): Promise<void> {
    const existing = await this.queue.getRepeatableJobs();
    const want = new Map<string, number>([
      [JOB_NAMES.snapshot60s, SCHEDULE_MS.snapshot60s],
      [JOB_NAMES.rollup5m, SCHEDULE_MS.rollup5m],
      [JOB_NAMES.summary30s, SCHEDULE_MS.summary30s],
    ]);

    for (const entry of existing) {
      const wantedMs = want.get(entry.name);
      if (wantedMs === undefined) {
        // Repeatable for a job we don't manage anymore — clean up.
        await this.queue.removeRepeatableByKey(entry.key);
        this.logger.log(`removed unknown repeatable: ${entry.name} (key=${entry.key})`);
        continue;
      }
      if (entry.every !== wantedMs) {
        await this.queue.removeRepeatableByKey(entry.key);
        this.logger.log(
          `removed stale repeatable: ${entry.name} every=${entry.every} != ${wantedMs}`,
        );
      }
    }
  }

  /**
   * Register the three repeatables with stable `jobId` so duplicate adds
   * across replicas dedupe at the queue level (Bull's atomic `addJob` key).
   */
  private async registerRepeatables(): Promise<void> {
    await this.queue.add(
      JOB_NAMES.snapshot60s,
      {},
      {
        ...STANDARD_JOB_OPTS,
        jobId: 'aggregator-snapshot60s',
        repeat: { every: SCHEDULE_MS.snapshot60s },
      },
    );
    await this.queue.add(
      JOB_NAMES.rollup5m,
      {},
      {
        ...STANDARD_JOB_OPTS,
        jobId: 'aggregator-rollup5m',
        repeat: { every: SCHEDULE_MS.rollup5m },
      },
    );
    await this.queue.add(
      JOB_NAMES.summary30s,
      {},
      {
        ...STANDARD_JOB_OPTS,
        jobId: 'aggregator-summary30s',
        repeat: { every: SCHEDULE_MS.summary30s },
      },
    );
    this.logger.log('markets-aggregator repeatables registered (60s / 5min / 30s)');
  }
}
