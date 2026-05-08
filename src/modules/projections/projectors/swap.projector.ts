import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { Transaction } from '../../../entities/transaction.entity.js';
import { type ProjectInput, requireBigStr, requirePubkey } from './types.js';

/**
 * SwapExecuted → `transactions` (kind='swap'). No LP-position side-effect
 * (swaps don't change LP shares; that's what `LiquidityAdded`/`Removed` are
 * for).
 *
 * Wire shape (`native-dex::SwapExecuted`, camelCase post-persister):
 *   - pool             (base58)
 *   - user             (base58 wallet)
 *   - aToB             (bool — direction; not stored, encoded into A/B order)
 *   - amountIn         (string bigint, what the swapper paid)
 *   - amountOut        (string bigint, what the swapper received)
 *   - feeLp            (LP fee — not projected, lives in markets module later)
 *   - feeProtocol      (protocol fee — same)
 *   - feeOtTreasury    (OT-treasury fee — same)
 *
 * `amountIn → amount_a` and `amountOut → amount_b` regardless of direction.
 * The portfolio activity feed renders this as "swapped X for Y" without
 * needing per-pool A/B convention awareness; the pool key carries the
 * mint pair on the markets side.
 */
@Injectable()
export class SwapProjector {
  async project(manager: EntityManager, input: ProjectInput): Promise<void> {
    const wallet = requirePubkey(input.data, 'user');
    const pool = requirePubkey(input.data, 'pool');
    const amountIn = requireBigStr(input.data, 'amountIn');
    const amountOut = requireBigStr(input.data, 'amountOut');

    const txRow: Partial<Transaction> = {
      signature: input.meta.signature,
      logIndex: input.meta.logIndex,
      kind: 'swap',
      wallet,
      otMint: null,
      pool,
      amountA: amountIn,
      amountB: amountOut,
      sharesDelta: null,
      blockTime: input.meta.blockTime,
      slot: String(input.meta.slot),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await manager.getRepository(Transaction).upsert(txRow as any, {
      conflictPaths: ['signature', 'logIndex'],
      skipUpdateIfNoValuesChanged: true,
    });
  }
}
