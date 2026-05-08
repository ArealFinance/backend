import { Counter } from 'prom-client';
import type { Server } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';

import type { MetricsService } from '../metrics/metrics.service.js';
import type { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeService } from './realtime.service.js';

/**
 * RealtimeService is a thin emit-only facade. The contract:
 *
 *   - Each emitX method calls `server.to(<correct room>).emit(<event>, payload)`.
 *   - Each emitX method increments `realtime_emits_total{channel=<event>}`.
 *   - When the underlying server isn't ready (early lifecycle / shutdown
 *     race), emits are no-ops AND no metric is incremented — silently
 *     dropping data is preferable to throwing inside a transaction.
 *
 * We mock the gateway and emit chain. The metric is a real prom-client
 * Counter (kept off the global registry via `registers: []`) so we can
 * assert against `.hashMap` without a wrapper.
 */

const POOL_KEY = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';
const WALLET = '8YN7TLUuZx3QmFRaeApaZJSPwtgJWHJWWQyExBzPZQQ8';

function makeServer(): { server: Server; emit: ReturnType<typeof vi.fn>; to: ReturnType<typeof vi.fn> } {
  const emit = vi.fn();
  const to = vi.fn().mockReturnValue({ emit });
  const server = { to } as unknown as Server;
  return { server, emit, to };
}

function makeMetrics(): {
  metrics: MetricsService;
  realtimeEmits: Counter;
} {
  // Isolated counter — registers: [] keeps it off the global registry so
  // multiple test files don't collide on metric name uniqueness.
  const realtimeEmits = new Counter({
    name: 'realtime_emits_total_test_stub',
    help: 'test stub',
    labelNames: ['channel'] as const,
    registers: [],
  });
  return {
    metrics: { realtimeEmits } as unknown as MetricsService,
    realtimeEmits,
  };
}

function makeService(opts: {
  server: Server | null;
  metrics: MetricsService;
}): RealtimeService {
  const gateway = { server: opts.server } as unknown as RealtimeGateway;
  return new RealtimeService(gateway, opts.metrics);
}

function metricCount(counter: Counter, labels: Record<string, string>): number {
  // prom-client exposes the labelled counter via `.labels(...).get()` only
  // through the parent — we walk the internal hashMap directly. Stable
  // shape across prom-client v15.x.
  const internal = counter as unknown as {
    hashMap: Record<string, { value: number; labels: Record<string, string> }>;
  };
  for (const entry of Object.values(internal.hashMap)) {
    if (Object.entries(labels).every(([k, v]) => entry.labels[k] === v)) {
      return entry.value;
    }
  }
  return 0;
}

describe('RealtimeService', () => {
  describe('emitProtocolSummaryTick', () => {
    it('emits to the protocol room with the correct event name + payload', () => {
      const { server, to, emit } = makeServer();
      const { metrics, realtimeEmits } = makeMetrics();
      const svc = makeService({ server, metrics });

      const payload = {
        totalTvlUsd: 1_000_000,
        volume24hUsd: 50_000,
        txCount24h: 100,
        activeWallets24h: 25,
        poolCount: 5,
        cumulativeDistributorCount: 3,
        blockTime: 1714780800,
      };
      svc.emitProtocolSummaryTick(payload);

      expect(to).toHaveBeenCalledWith('protocol');
      expect(emit).toHaveBeenCalledWith('protocol_summary_tick', payload);
      expect(metricCount(realtimeEmits, { channel: 'protocol_summary_tick' })).toBe(1);
    });
  });

  describe('emitPoolSnapshot', () => {
    it('emits to pool:<base58> with the correct event name + payload', () => {
      const { server, to, emit } = makeServer();
      const { metrics, realtimeEmits } = makeMetrics();
      const svc = makeService({ server, metrics });

      const payload = {
        pool: POOL_KEY,
        blockTime: 1714780800,
        tvlA: '100',
        tvlB: '200',
        tvlUsd: 1234,
        reserveA: '100',
        reserveB: '200',
        feeGrowthA: '0',
        feeGrowthB: '0',
        lpSupply: '50',
      };
      svc.emitPoolSnapshot(payload);

      expect(to).toHaveBeenCalledWith(`pool:${POOL_KEY}`);
      expect(emit).toHaveBeenCalledWith('pool_snapshot', payload);
      expect(metricCount(realtimeEmits, { channel: 'pool_snapshot' })).toBe(1);
    });
  });

  describe('emitTransactionIndexed', () => {
    it('emits to wallet:<base58> with the correct event name + payload', () => {
      const { server, to, emit } = makeServer();
      const { metrics, realtimeEmits } = makeMetrics();
      const svc = makeService({ server, metrics });

      const payload = {
        wallet: WALLET,
        kind: 'swap',
        signature: '5fJk',
        blockTime: 1714780800,
      };
      svc.emitTransactionIndexed(payload);

      expect(to).toHaveBeenCalledWith(`wallet:${WALLET}`);
      expect(emit).toHaveBeenCalledWith('transaction_indexed', payload);
      expect(metricCount(realtimeEmits, { channel: 'transaction_indexed' })).toBe(1);
    });
  });

  describe('null server (early lifecycle / shutdown race)', () => {
    it('emitPoolSnapshot is a no-op and does NOT increment the emit metric', () => {
      const { metrics, realtimeEmits } = makeMetrics();
      const svc = makeService({ server: null, metrics });

      expect(() =>
        svc.emitPoolSnapshot({
          pool: POOL_KEY,
          blockTime: 0,
          tvlA: '0',
          tvlB: '0',
          tvlUsd: null,
          reserveA: '0',
          reserveB: '0',
          feeGrowthA: '0',
          feeGrowthB: '0',
          lpSupply: '0',
        }),
      ).not.toThrow();

      expect(metricCount(realtimeEmits, { channel: 'pool_snapshot' })).toBe(0);
    });

    it('emitProtocolSummaryTick is a no-op and does NOT increment the emit metric', () => {
      const { metrics, realtimeEmits } = makeMetrics();
      const svc = makeService({ server: null, metrics });

      expect(() =>
        svc.emitProtocolSummaryTick({
          totalTvlUsd: 0,
          volume24hUsd: 0,
          txCount24h: 0,
          activeWallets24h: 0,
          poolCount: 0,
          cumulativeDistributorCount: 0,
          blockTime: 0,
        }),
      ).not.toThrow();

      expect(metricCount(realtimeEmits, { channel: 'protocol_summary_tick' })).toBe(0);
    });

    it('emitTransactionIndexed is a no-op and does NOT increment the emit metric', () => {
      const { metrics, realtimeEmits } = makeMetrics();
      const svc = makeService({ server: null, metrics });

      expect(() =>
        svc.emitTransactionIndexed({
          wallet: WALLET,
          kind: 'swap',
          signature: '5fJk',
          blockTime: 0,
        }),
      ).not.toThrow();

      expect(metricCount(realtimeEmits, { channel: 'transaction_indexed' })).toBe(0);
    });
  });
});
