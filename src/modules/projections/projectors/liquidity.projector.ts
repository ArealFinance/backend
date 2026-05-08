import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { LpPositionHistory } from '../../../entities/lp-position-history.entity.js';
import { Transaction } from '../../../entities/transaction.entity.js';
import { negateBigStr, type ProjectInput, requireBigStr, requirePubkey } from './types.js';

/**
 * Liquidity-side projector — handles four event names with one class so the
 * shared shape (provider + paired amounts + signed share delta) lives in one
 * place.
 *
 * Event-name mapping:
 *   - LiquidityAdded         → tx.kind='add_lp',     lp.kind='add',    delta=+sharesMinted
 *   - LiquidityRemoved       → tx.kind='remove_lp',  lp.kind='remove', delta=-sharesBurned
 *   - ZapLiquidityExecuted   → tx.kind='zap_lp',     lp.kind='zap',    delta=+sharesMinted
 *   - RwtMinted              → tx.kind='mint_rwt'    (NO lp_position_history row)
 *
 * RwtMinted lives here only because its wire shape (provider + paired
 * amounts) parallels the AMM events and the dispatcher routing is cleaner.
 * Functionally it's an OT-engine action that DOES NOT touch the AMM, so we
 * write `transactions` only.
 *
 * Wire shapes (camelCase post-persister):
 *   LiquidityAdded   { pool, provider, amountA, amountB, sharesMinted }
 *   LiquidityRemoved { pool, provider, amountA, amountB, sharesBurned }
 *   ZapLiquidityExecuted { pool, provider, inputA, inputB, swappedAmount,
 *                          sharesMinted }
 *   RwtMinted        { user, depositAmount, rwtAmount, feeVault, feeDao,
 *                      navAfter, isAdmin, timestamp }
 */
@Injectable()
export class LiquidityProjector {
  async project(manager: EntityManager, input: ProjectInput): Promise<void> {
    switch (input.eventName) {
      case 'LiquidityAdded':
        await this.projectAdd(manager, input);
        return;
      case 'LiquidityRemoved':
        await this.projectRemove(manager, input);
        return;
      case 'ZapLiquidityExecuted':
        await this.projectZap(manager, input);
        return;
      case 'RwtMinted':
        await this.projectRwtMint(manager, input);
        return;
      default:
        throw new Error(`LiquidityProjector: unhandled event "${input.eventName}"`);
    }
  }

  private async projectAdd(manager: EntityManager, input: ProjectInput): Promise<void> {
    const wallet = requirePubkey(input.data, 'provider');
    const pool = requirePubkey(input.data, 'pool');
    const amountA = requireBigStr(input.data, 'amountA');
    const amountB = requireBigStr(input.data, 'amountB');
    const sharesDelta = requireBigStr(input.data, 'sharesMinted');

    await this.upsertTx(manager, input, {
      kind: 'add_lp',
      wallet,
      pool,
      amountA,
      amountB,
      sharesDelta,
    });
    await this.upsertLp(manager, input, {
      kind: 'add',
      wallet,
      pool,
      amountA,
      amountB,
      sharesDelta,
    });
  }

  private async projectRemove(manager: EntityManager, input: ProjectInput): Promise<void> {
    const wallet = requirePubkey(input.data, 'provider');
    const pool = requirePubkey(input.data, 'pool');
    const amountA = requireBigStr(input.data, 'amountA');
    const amountB = requireBigStr(input.data, 'amountB');
    const burned = requireBigStr(input.data, 'sharesBurned');
    const sharesDelta = negateBigStr(burned);

    await this.upsertTx(manager, input, {
      kind: 'remove_lp',
      wallet,
      pool,
      amountA,
      amountB,
      sharesDelta,
    });
    await this.upsertLp(manager, input, {
      kind: 'remove',
      wallet,
      pool,
      amountA,
      amountB,
      sharesDelta,
    });
  }

  private async projectZap(manager: EntityManager, input: ProjectInput): Promise<void> {
    const wallet = requirePubkey(input.data, 'provider');
    const pool = requirePubkey(input.data, 'pool');
    const amountA = requireBigStr(input.data, 'inputA');
    const amountB = requireBigStr(input.data, 'inputB');
    const sharesDelta = requireBigStr(input.data, 'sharesMinted');

    await this.upsertTx(manager, input, {
      kind: 'zap_lp',
      wallet,
      pool,
      amountA,
      amountB,
      sharesDelta,
    });
    await this.upsertLp(manager, input, {
      kind: 'zap',
      wallet,
      pool,
      amountA,
      amountB,
      sharesDelta,
    });
  }

  private async projectRwtMint(manager: EntityManager, input: ProjectInput): Promise<void> {
    const wallet = requirePubkey(input.data, 'user');
    const depositAmount = requireBigStr(input.data, 'depositAmount');
    const rwtAmount = requireBigStr(input.data, 'rwtAmount');

    await this.upsertTx(manager, input, {
      kind: 'mint_rwt',
      wallet,
      pool: null,
      amountA: depositAmount,
      amountB: rwtAmount,
      sharesDelta: null,
    });
    // Intentionally NO `lp_position_history` row — RWT minting is an
    // OT-engine action that mints synthetic RWT tokens against a deposit;
    // it doesn't change AMM LP shares.
  }

  private async upsertTx(
    manager: EntityManager,
    input: ProjectInput,
    fields: Pick<Transaction, 'kind' | 'wallet' | 'pool' | 'amountA' | 'amountB' | 'sharesDelta'>,
  ): Promise<void> {
    const row: Partial<Transaction> = {
      signature: input.meta.signature,
      logIndex: input.meta.logIndex,
      blockTime: input.meta.blockTime,
      slot: String(input.meta.slot),
      otMint: null,
      ...fields,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await manager.getRepository(Transaction).upsert(row as any, {
      conflictPaths: ['signature', 'logIndex'],
      skipUpdateIfNoValuesChanged: true,
    });
  }

  private async upsertLp(
    manager: EntityManager,
    input: ProjectInput,
    fields: Pick<
      LpPositionHistory,
      'kind' | 'wallet' | 'pool' | 'amountA' | 'amountB' | 'sharesDelta'
    >,
  ): Promise<void> {
    const row: Partial<LpPositionHistory> = {
      signature: input.meta.signature,
      logIndex: input.meta.logIndex,
      blockTime: input.meta.blockTime,
      ...fields,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await manager.getRepository(LpPositionHistory).upsert(row as any, {
      conflictPaths: ['signature', 'logIndex'],
      skipUpdateIfNoValuesChanged: true,
    });
  }
}
