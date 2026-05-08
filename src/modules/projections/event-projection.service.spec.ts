import { PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';

import { MetricsService } from '../metrics/metrics.service.js';
import { EventProjectionService } from './event-projection.service.js';
import type { ClaimProjector } from './projectors/claim.projector.js';
import type { LiquidityProjector } from './projectors/liquidity.projector.js';
import type { RevenueProjector } from './projectors/revenue.projector.js';
import type { SwapProjector } from './projectors/swap.projector.js';

/**
 * Dispatcher tests. We mock all four projectors so we can assert the
 * routing-by-event-name contract independently of the per-projector logic
 * (which has its own spec).
 *
 * MetricsService uses `prom-client`'s default registry implicitly inside
 * its `new Counter()` constructor calls (the prom-client library registers
 * each metric globally), so we keep ONE shared instance across all tests in
 * this file. Re-instantiating would throw "metric already registered".
 */

const SHARED_METRICS = new MetricsService();
const VALID_WALLET = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';

function makeService(): {
  service: EventProjectionService;
  metrics: MetricsService;
  claim: { project: ReturnType<typeof vi.fn> };
  swap: { project: ReturnType<typeof vi.fn> };
  liquidity: { project: ReturnType<typeof vi.fn> };
  revenue: { project: ReturnType<typeof vi.fn> };
} {
  const claim = { project: vi.fn().mockResolvedValue(undefined) };
  const swap = { project: vi.fn().mockResolvedValue(undefined) };
  const liquidity = { project: vi.fn().mockResolvedValue(undefined) };
  const revenue = { project: vi.fn().mockResolvedValue(undefined) };
  const service = new EventProjectionService(
    claim as unknown as ClaimProjector,
    swap as unknown as SwapProjector,
    liquidity as unknown as LiquidityProjector,
    revenue as unknown as RevenueProjector,
    SHARED_METRICS,
  );
  return { service, metrics: SHARED_METRICS, claim, swap, liquidity, revenue };
}

const META = {
  signature: 'sig-x-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  logIndex: 3,
  slot: 100,
  blockTime: new Date('2026-05-08T10:00:00.000Z'),
};
const PROGRAM = new PublicKey('11111111111111111111111111111111');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const FAKE_MANAGER = {} as any;

function decoded(eventName: string, data: Record<string, unknown> = {}) {
  return {
    programId: PROGRAM,
    programName: 'native-dex' as const,
    eventName,
    data,
  };
}

async function counterValue(metrics: MetricsService, eventName: string): Promise<number> {
  const v = await metrics.projectionErrors.get();
  return v.values.find((x) => x.labels.event_name === eventName)?.value ?? 0;
}

async function histogramCount(metrics: MetricsService): Promise<number> {
  const v = await metrics.projectionLatency.get();
  return (
    v.values.find((x) => x.metricName === 'areal_projection_latency_seconds_count')?.value ?? 0
  );
}

describe('EventProjectionService (dispatcher)', () => {
  it('routes RewardsClaimed to ClaimProjector', async () => {
    const { service, claim, swap, liquidity, revenue } = makeService();
    await service.projectInTx(FAKE_MANAGER, decoded('RewardsClaimed', { foo: 1 }), META);
    expect(claim.project).toHaveBeenCalledOnce();
    expect(swap.project).not.toHaveBeenCalled();
    expect(liquidity.project).not.toHaveBeenCalled();
    expect(revenue.project).not.toHaveBeenCalled();
  });

  it('routes SwapExecuted to SwapProjector', async () => {
    const { service, claim, swap, liquidity, revenue } = makeService();
    await service.projectInTx(FAKE_MANAGER, decoded('SwapExecuted'), META);
    expect(swap.project).toHaveBeenCalledOnce();
    expect(claim.project).not.toHaveBeenCalled();
    expect(liquidity.project).not.toHaveBeenCalled();
    expect(revenue.project).not.toHaveBeenCalled();
  });

  it.each(['LiquidityAdded', 'LiquidityRemoved', 'ZapLiquidityExecuted', 'RwtMinted'])(
    'routes %s to LiquidityProjector',
    async (name) => {
      const { service, liquidity } = makeService();
      await service.projectInTx(FAKE_MANAGER, decoded(name), META);
      expect(liquidity.project).toHaveBeenCalledOnce();
    },
  );

  it('routes RevenueDistributed to RevenueProjector', async () => {
    const { service, revenue } = makeService();
    await service.projectInTx(FAKE_MANAGER, decoded('RevenueDistributed'), META);
    expect(revenue.project).toHaveBeenCalledOnce();
  });

  it('silently skips unknown event names (no projector called, no throw)', async () => {
    const { service, claim, swap, liquidity, revenue } = makeService();
    await expect(
      service.projectInTx(FAKE_MANAGER, decoded('SomeFutureEventNotProjected'), META),
    ).resolves.toBeNull();
    expect(claim.project).not.toHaveBeenCalled();
    expect(swap.project).not.toHaveBeenCalled();
    expect(liquidity.project).not.toHaveBeenCalled();
    expect(revenue.project).not.toHaveBeenCalled();
  });

  it('re-throws projector errors and increments the error counter', async () => {
    const { service, metrics, claim } = makeService();
    claim.project.mockRejectedValueOnce(new Error('boom'));
    const before = await counterValue(metrics, 'RewardsClaimed');
    await expect(
      service.projectInTx(FAKE_MANAGER, decoded('RewardsClaimed'), META),
    ).rejects.toThrow(/boom/);
    const after = await counterValue(metrics, 'RewardsClaimed');
    expect(after - before).toBe(1);
  });

  it('records latency for every successful projection', async () => {
    const { service, metrics } = makeService();
    const before = await histogramCount(metrics);
    await service.projectInTx(FAKE_MANAGER, decoded('SwapExecuted'), META);
    const after = await histogramCount(metrics);
    expect(after - before).toBe(1);
  });

  // ── Phase 12.3.1: emit-payload returns ───────────────────────────────────
  // The 6 wallet-keyed kinds return a payload that the indexer consumer
  // fans out POST-COMMIT. Tests below pin the contract so the realtime
  // wire-up at the consumer layer can rely on it.

  it.each([
    [
      'RewardsClaimed',
      { claimant: VALID_WALLET, otMint: 'OT-mint', amount: '1', cumulativeClaimed: '5' },
      'claim',
    ],
    ['SwapExecuted', { user: VALID_WALLET, pool: 'POOL', amountIn: '1', amountOut: '2' }, 'swap'],
    [
      'LiquidityAdded',
      { provider: VALID_WALLET, pool: 'POOL', amountA: '1', amountB: '2', sharesMinted: '3' },
      'add_lp',
    ],
    [
      'LiquidityRemoved',
      { provider: VALID_WALLET, pool: 'POOL', amountA: '1', amountB: '2', sharesBurned: '3' },
      'remove_lp',
    ],
    [
      'ZapLiquidityExecuted',
      { provider: VALID_WALLET, pool: 'POOL', inputA: '1', inputB: '2', sharesMinted: '3' },
      'zap_lp',
    ],
    ['RwtMinted', { user: VALID_WALLET, depositAmount: '1', rwtAmount: '2' }, 'mint_rwt'],
  ])('returns emit payload {kind=%s} for %s', async (eventName, data, expectedKind) => {
    const { service } = makeService();
    const payload = await service.projectInTx(
      FAKE_MANAGER,
      decoded(eventName as string, data as Record<string, unknown>),
      META,
    );
    expect(payload).not.toBeNull();
    expect(payload?.kind).toBe(expectedKind);
    expect(payload?.wallet).toBe(VALID_WALLET);
    expect(payload?.signature).toBe(META.signature);
  });

  it('returns null for RevenueDistributed (wallet-less event, no per-wallet emit)', async () => {
    const { service } = makeService();
    const payload = await service.projectInTx(
      FAKE_MANAGER,
      decoded('RevenueDistributed', {
        otMint: 'OT-mint',
        totalAmount: '1000',
        protocolFee: '10',
        distributionCount: 5,
        numDestinations: 3,
      }),
      META,
    );
    expect(payload).toBeNull();
  });

  it('does NOT return an emit payload when the projector throws', async () => {
    const { service, claim } = makeService();
    claim.project.mockRejectedValueOnce(new Error('rollback'));
    await expect(
      service.projectInTx(
        FAKE_MANAGER,
        decoded('RewardsClaimed', { claimant: VALID_WALLET }),
        META,
      ),
    ).rejects.toThrow(/rollback/);
    // The throw means the emit never reaches the caller — verified by the
    // dispatcher's `try/catch/finally` shape (no return path past the throw).
    // The post-commit fan-out in IndexerConsumer is gated on a successful
    // resolution, so a thrown error guarantees no realtime leak.
    expect(claim.project).toHaveBeenCalledOnce();
  });
});
