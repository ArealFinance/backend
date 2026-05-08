import { describe, expect, it, vi } from 'vitest';

import { ClaimHistory } from '../../../entities/claim-history.entity.js';
import { LpPositionHistory } from '../../../entities/lp-position-history.entity.js';
import { RevenueDistribution } from '../../../entities/revenue-distribution.entity.js';
import { Transaction } from '../../../entities/transaction.entity.js';
import { ClaimProjector } from './claim.projector.js';
import { LiquidityProjector } from './liquidity.projector.js';
import { RevenueProjector } from './revenue.projector.js';
import { SwapProjector } from './swap.projector.js';
import type { ProjectInput } from './types.js';

/**
 * Per-projector tests. We don't spin up Postgres — EntityManager is mocked
 * with `getRepository → { upsert }` so we capture the row payload sent to
 * UPSERT and assert the column-by-column mapping. Each projector also gets
 * an idempotency check (re-running with the same input is a no-op-ish call;
 * the persister relies on conflict-do-nothing at the DB layer, so all the
 * projector contract guarantees here is "doesn't throw on the second call").
 */

interface UpsertCall {
  entity: unknown;
  row: Record<string, unknown>;
  options: Record<string, unknown>;
}

function makeManager() {
  const calls: UpsertCall[] = [];
  const upsert = vi.fn(async (row: unknown, options: unknown) => {
    calls.push({
      entity: undefined,
      row: row as Record<string, unknown>,
      options: options as Record<string, unknown>,
    });
  });
  const getRepository = vi.fn((entity: unknown) => ({
    upsert: vi.fn(async (row: unknown, options: unknown) => {
      calls.push({
        entity,
        row: row as Record<string, unknown>,
        options: options as Record<string, unknown>,
      });
    }),
  }));
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    manager: { getRepository } as any,
    upsert,
    calls,
    getRepository,
  };
}

const META = {
  signature: 'sig-test-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  logIndex: 0,
  slot: 100,
  blockTime: new Date('2026-05-08T10:00:00.000Z'),
};

// ---------------------------------------------------------------------------
// ClaimProjector
// ---------------------------------------------------------------------------

describe('ClaimProjector', () => {
  const projector = new ClaimProjector();

  const validInput: ProjectInput = {
    eventName: 'RewardsClaimed',
    meta: META,
    data: {
      claimant: '11111111111111111111111111111111',
      otMint: '22222222222222222222222222222222',
      amount: '1000000',
      cumulativeClaimed: '5000000',
    },
  };

  it('writes one row to transactions and one to claim_history', async () => {
    const m = makeManager();
    await projector.project(m.manager, validInput);
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0]!.entity).toBe(Transaction);
    expect(m.calls[1]!.entity).toBe(ClaimHistory);
  });

  it('maps fields correctly into transactions row', async () => {
    const m = makeManager();
    await projector.project(m.manager, validInput);
    const tx = m.calls[0]!.row;
    expect(tx).toMatchObject({
      signature: META.signature,
      logIndex: 0,
      kind: 'claim',
      wallet: '11111111111111111111111111111111',
      otMint: '22222222222222222222222222222222',
      pool: null,
      amountA: '1000000',
      amountB: null,
      sharesDelta: null,
      slot: '100',
    });
    expect((tx.blockTime as Date).getTime()).toBe(META.blockTime.getTime());
  });

  it('maps fields correctly into claim_history row', async () => {
    const m = makeManager();
    await projector.project(m.manager, validInput);
    const claim = m.calls[1]!.row;
    expect(claim).toMatchObject({
      signature: META.signature,
      logIndex: 0,
      wallet: '11111111111111111111111111111111',
      otMint: '22222222222222222222222222222222',
      amount: '1000000',
      cumulativeClaimed: '5000000',
    });
  });

  it('uses conflict-do-nothing on (signature, logIndex)', async () => {
    const m = makeManager();
    await projector.project(m.manager, validInput);
    for (const c of m.calls) {
      expect(c.options).toMatchObject({
        conflictPaths: ['signature', 'logIndex'],
        skipUpdateIfNoValuesChanged: true,
      });
    }
  });

  it('is idempotent — re-running does not throw', async () => {
    const m = makeManager();
    await projector.project(m.manager, validInput);
    await expect(projector.project(m.manager, validInput)).resolves.toBeUndefined();
    expect(m.calls).toHaveLength(4);
  });

  it('throws on missing claimant', async () => {
    const m = makeManager();
    const { claimant: _, ...rest } = validInput.data;
    void _;
    await expect(projector.project(m.manager, { ...validInput, data: rest })).rejects.toThrow(
      /claimant/,
    );
  });
});

// ---------------------------------------------------------------------------
// SwapProjector
// ---------------------------------------------------------------------------

describe('SwapProjector', () => {
  const projector = new SwapProjector();

  const validInput: ProjectInput = {
    eventName: 'SwapExecuted',
    meta: META,
    data: {
      pool: '33333333333333333333333333333333',
      user: '11111111111111111111111111111111',
      aToB: true,
      amountIn: '500',
      amountOut: '480',
      feeLp: '1',
      feeProtocol: '1',
      feeOtTreasury: '1',
    },
  };

  it('writes a single row to transactions only', async () => {
    const m = makeManager();
    await projector.project(m.manager, validInput);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.entity).toBe(Transaction);
  });

  it('encodes amount_in → amountA and amount_out → amountB', async () => {
    const m = makeManager();
    await projector.project(m.manager, validInput);
    const row = m.calls[0]!.row;
    expect(row).toMatchObject({
      kind: 'swap',
      wallet: '11111111111111111111111111111111',
      pool: '33333333333333333333333333333333',
      amountA: '500',
      amountB: '480',
      sharesDelta: null,
      otMint: null,
    });
  });
});

// ---------------------------------------------------------------------------
// LiquidityProjector
// ---------------------------------------------------------------------------

describe('LiquidityProjector', () => {
  const projector = new LiquidityProjector();

  const baseAmm = {
    pool: '33333333333333333333333333333333',
    provider: '11111111111111111111111111111111',
  };

  it('LiquidityAdded → transactions(kind=add_lp) + lp_position_history(kind=add)', async () => {
    const m = makeManager();
    await projector.project(m.manager, {
      eventName: 'LiquidityAdded',
      meta: META,
      data: { ...baseAmm, amountA: '100', amountB: '200', sharesMinted: '300' },
    });
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0]!.entity).toBe(Transaction);
    expect(m.calls[0]!.row).toMatchObject({
      kind: 'add_lp',
      wallet: '11111111111111111111111111111111',
      pool: '33333333333333333333333333333333',
      amountA: '100',
      amountB: '200',
      sharesDelta: '300',
    });
    expect(m.calls[1]!.entity).toBe(LpPositionHistory);
    expect(m.calls[1]!.row).toMatchObject({ kind: 'add', sharesDelta: '300' });
  });

  it('LiquidityRemoved → transactions(kind=remove_lp) + lp_position_history(kind=remove, NEGATIVE delta)', async () => {
    const m = makeManager();
    await projector.project(m.manager, {
      eventName: 'LiquidityRemoved',
      meta: META,
      data: { ...baseAmm, amountA: '100', amountB: '200', sharesBurned: '300' },
    });
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0]!.row).toMatchObject({ kind: 'remove_lp', sharesDelta: '-300' });
    expect(m.calls[1]!.row).toMatchObject({ kind: 'remove', sharesDelta: '-300' });
  });

  it('ZapLiquidityExecuted → kind=zap_lp / zap and uses input_a/input_b', async () => {
    const m = makeManager();
    await projector.project(m.manager, {
      eventName: 'ZapLiquidityExecuted',
      meta: META,
      data: {
        ...baseAmm,
        inputA: '500',
        inputB: '0',
        swappedAmount: '249',
        sharesMinted: '777',
      },
    });
    expect(m.calls[0]!.row).toMatchObject({
      kind: 'zap_lp',
      amountA: '500',
      amountB: '0',
      sharesDelta: '777',
    });
    expect(m.calls[1]!.row).toMatchObject({ kind: 'zap', sharesDelta: '777' });
  });

  it('RwtMinted → transactions only (NO lp_position_history)', async () => {
    const m = makeManager();
    await projector.project(m.manager, {
      eventName: 'RwtMinted',
      meta: META,
      data: {
        user: '11111111111111111111111111111111',
        depositAmount: '1000',
        rwtAmount: '950',
        feeVault: '25',
        feeDao: '25',
        navAfter: '1000000000',
        isAdmin: false,
        timestamp: '1715040000',
      },
    });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.entity).toBe(Transaction);
    expect(m.calls[0]!.row).toMatchObject({
      kind: 'mint_rwt',
      wallet: '11111111111111111111111111111111',
      pool: null,
      amountA: '1000',
      amountB: '950',
      sharesDelta: null,
    });
  });

  it('throws on unhandled event name', async () => {
    const m = makeManager();
    await expect(
      projector.project(m.manager, {
        eventName: 'NotARealLiquidityEvent',
        meta: META,
        data: {},
      }),
    ).rejects.toThrow(/unhandled event/);
  });

  it('is idempotent for LiquidityAdded', async () => {
    const m = makeManager();
    const input: ProjectInput = {
      eventName: 'LiquidityAdded',
      meta: META,
      data: { ...baseAmm, amountA: '1', amountB: '1', sharesMinted: '1' },
    };
    await projector.project(m.manager, input);
    await expect(projector.project(m.manager, input)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RevenueProjector
// ---------------------------------------------------------------------------

describe('RevenueProjector', () => {
  const projector = new RevenueProjector();

  const validInput: ProjectInput = {
    eventName: 'RevenueDistributed',
    meta: META,
    data: {
      otMint: '22222222222222222222222222222222',
      totalAmount: '1000000',
      protocolFee: '50000',
      distributionCount: 7,
      numDestinations: 12,
      timestamp: '1715040000',
    },
  };

  it('writes a single row to revenue_distributions only (NEVER transactions)', async () => {
    const m = makeManager();
    await projector.project(m.manager, validInput);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.entity).toBe(RevenueDistribution);
  });

  it('maps every column correctly', async () => {
    const m = makeManager();
    await projector.project(m.manager, validInput);
    expect(m.calls[0]!.row).toMatchObject({
      signature: META.signature,
      logIndex: 0,
      otMint: '22222222222222222222222222222222',
      totalAmount: '1000000',
      protocolFee: '50000',
      distributionCount: 7,
      numDestinations: 12,
    });
  });

  it('coerces stringified u64 distribution_count into a JS number', async () => {
    const m = makeManager();
    await projector.project(m.manager, {
      ...validInput,
      data: { ...validInput.data, distributionCount: '42' },
    });
    expect(m.calls[0]!.row.distributionCount).toBe(42);
  });
});
