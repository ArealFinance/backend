import type { Queue } from 'bull';
import { describe, expect, it, vi } from 'vitest';

import { MarketsAggregatorBootstrap } from './markets-aggregator.bootstrap.js';
import { JOB_NAMES } from './markets-aggregator.consumer.js';

/**
 * Bootstrap unit tests (R-12.3.1-5).
 *
 * The bootstrap performs two side-effects on `OnModuleInit`:
 *   1. Read repeatables, drop any stale (unknown name OR wrong cadence).
 *   2. Re-add the three current repeatables with stable jobIds.
 *
 * All Bull I/O is mocked. The advisory-lock semantics live in the
 * service, so this file only pins the LIFECYCLE: order of calls,
 * stale-removal coverage, and idempotent re-init shape.
 */

interface RepeatableShape {
  name: string;
  every: number;
  key: string;
}

function makeQueue(existing: RepeatableShape[] = []) {
  const getRepeatableJobs = vi.fn().mockResolvedValue(existing);
  const removeRepeatableByKey = vi.fn().mockResolvedValue(undefined);
  const add = vi.fn().mockResolvedValue(undefined);
  return {
    queue: {
      getRepeatableJobs,
      removeRepeatableByKey,
      add,
    } as unknown as Queue,
    getRepeatableJobs,
    removeRepeatableByKey,
    add,
  };
}

describe('MarketsAggregatorBootstrap', () => {
  it('calls cleanStaleRepeatables before registerRepeatables on init', async () => {
    const { queue, getRepeatableJobs, add } = makeQueue();
    const bootstrap = new MarketsAggregatorBootstrap(queue);

    await bootstrap.onModuleInit();

    // Pin the order: stale-clean (read repeatables) must complete BEFORE
    // any `add` runs. We can't observe the call order across distinct
    // mocks directly, so we assert getRepeatableJobs was called and
    // adds came in afterwards.
    expect(getRepeatableJobs).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledTimes(3);
    // mock.invocationCallOrder is monotonic across all vi.fn() mocks in
    // a single run — we use it to assert the intended sequencing.
    const readOrder = getRepeatableJobs.mock.invocationCallOrder[0]!;
    const firstAddOrder = add.mock.invocationCallOrder[0]!;
    expect(readOrder).toBeLessThan(firstAddOrder);
  });

  it('removes repeatables with an unknown job name', async () => {
    const { queue, removeRepeatableByKey } = makeQueue([
      { name: 'legacy-job-from-prior-deploy', every: 60_000, key: 'k-legacy' },
    ]);
    const bootstrap = new MarketsAggregatorBootstrap(queue);

    await bootstrap.onModuleInit();

    expect(removeRepeatableByKey).toHaveBeenCalledWith('k-legacy');
  });

  it('removes repeatables whose every-ms differs from the current schedule', async () => {
    // Stale snapshot60s with the old 90s cadence — must be removed.
    const { queue, removeRepeatableByKey } = makeQueue([
      { name: JOB_NAMES.snapshot60s, every: 90_000, key: 'k-stale-snapshot' },
    ]);
    const bootstrap = new MarketsAggregatorBootstrap(queue);

    await bootstrap.onModuleInit();

    expect(removeRepeatableByKey).toHaveBeenCalledWith('k-stale-snapshot');
  });

  it('does not remove repeatables that match the current schedule', async () => {
    const { queue, removeRepeatableByKey } = makeQueue([
      { name: JOB_NAMES.snapshot60s, every: 60_000, key: 'k-current' },
    ]);
    const bootstrap = new MarketsAggregatorBootstrap(queue);

    await bootstrap.onModuleInit();

    expect(removeRepeatableByKey).not.toHaveBeenCalledWith('k-current');
  });

  it('registers exactly 3 repeatables with the correct intervals + stable jobIds', async () => {
    const { queue, add } = makeQueue();
    const bootstrap = new MarketsAggregatorBootstrap(queue);

    await bootstrap.onModuleInit();

    expect(add).toHaveBeenCalledTimes(3);

    const calls = add.mock.calls.map(([name, _payload, opts]) => ({
      name,
      jobId: (opts as { jobId: string }).jobId,
      every: (opts as { repeat: { every: number } }).repeat.every,
    }));

    expect(calls).toEqual(
      expect.arrayContaining([
        { name: JOB_NAMES.snapshot60s, jobId: 'aggregator-snapshot60s', every: 60_000 },
        { name: JOB_NAMES.rollup5m, jobId: 'aggregator-rollup5m', every: 300_000 },
        { name: JOB_NAMES.summary30s, jobId: 'aggregator-summary30s', every: 30_000 },
      ]),
    );
  });

  it('is idempotent on re-init — Bull dedupes by stable jobId, no duplicate side-effects', async () => {
    // Bull's `add(name, payload, { jobId })` is idempotent under the hood
    // when called with a stable jobId. We can't observe Bull's internal
    // dedup here (the queue is mocked), but the test pins that the
    // bootstrap calls `add` with the SAME jobId on every invocation —
    // which is the contract Bull's dedup relies on. A re-init that
    // somehow generated a fresh jobId would slip past Bull and create
    // duplicate repeatables; this test prevents that regression.
    const { queue, add } = makeQueue();
    const bootstrap = new MarketsAggregatorBootstrap(queue);

    await bootstrap.onModuleInit();
    await bootstrap.onModuleInit();

    const jobIds = add.mock.calls.map(
      ([, , opts]) => (opts as { jobId: string }).jobId,
    );
    // 3 jobs × 2 inits = 6 calls; jobIds must be stable across inits.
    expect(jobIds).toHaveLength(6);
    expect(new Set(jobIds).size).toBe(3); // exactly 3 unique stable jobIds
  });
});
