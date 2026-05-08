import { describe, expect, it, vi } from 'vitest';

import { MarketsAggregatorConsumer } from './markets-aggregator.consumer.js';
import type { MarketsAggregatorService } from './markets-aggregator.service.js';

/**
 * Consumer is a thin Bull `@Process` adapter — three handlers, each
 * dispatching to the matching service method. Tests pin that mapping
 * so a future refactor that swaps the names doesn't silently route
 * `snapshot60s` to `rollupDailyAggregates5m` (which would persist into
 * the wrong table on the next cron tick).
 *
 * The service is fully mocked. Handler return values are not part of
 * the contract — Bull treats `void` as "job done"; failures bubble up
 * and Bull marks the job failed.
 */

function makeService() {
  return {
    snapshotPools60s: vi.fn().mockResolvedValue(undefined),
    rollupDailyAggregates5m: vi.fn().mockResolvedValue(undefined),
    writeProtocolSummary30s: vi.fn().mockResolvedValue(undefined),
  } as unknown as MarketsAggregatorService;
}

describe('MarketsAggregatorConsumer', () => {
  it('snapshot60s handler delegates to MarketsAggregatorService.snapshotPools60s', async () => {
    const service = makeService();
    const consumer = new MarketsAggregatorConsumer(service);

    await consumer.handleSnapshot();

    expect(service.snapshotPools60s).toHaveBeenCalledOnce();
    expect(service.rollupDailyAggregates5m).not.toHaveBeenCalled();
    expect(service.writeProtocolSummary30s).not.toHaveBeenCalled();
  });

  it('rollup5m handler delegates to MarketsAggregatorService.rollupDailyAggregates5m', async () => {
    const service = makeService();
    const consumer = new MarketsAggregatorConsumer(service);

    await consumer.handleRollup();

    expect(service.rollupDailyAggregates5m).toHaveBeenCalledOnce();
    expect(service.snapshotPools60s).not.toHaveBeenCalled();
    expect(service.writeProtocolSummary30s).not.toHaveBeenCalled();
  });

  it('summary30s handler delegates to MarketsAggregatorService.writeProtocolSummary30s', async () => {
    const service = makeService();
    const consumer = new MarketsAggregatorConsumer(service);

    await consumer.handleSummary();

    expect(service.writeProtocolSummary30s).toHaveBeenCalledOnce();
    expect(service.snapshotPools60s).not.toHaveBeenCalled();
    expect(service.rollupDailyAggregates5m).not.toHaveBeenCalled();
  });

  it('propagates service errors to Bull (handler does not swallow)', async () => {
    // Bull marks the job failed on a thrown handler; the consumer must
    // not catch the error or the failure path of the service is invisible
    // to the queue (and stale jobs accumulate without alerting).
    const service = makeService();
    const boom = new Error('rpc 500');
    (service.snapshotPools60s as ReturnType<typeof vi.fn>).mockRejectedValueOnce(boom);
    const consumer = new MarketsAggregatorConsumer(service);

    await expect(consumer.handleSnapshot()).rejects.toBe(boom);
  });
});
