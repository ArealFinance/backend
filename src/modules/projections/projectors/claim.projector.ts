import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { ClaimHistory } from '../../../entities/claim-history.entity.js';
import { Transaction } from '../../../entities/transaction.entity.js';
import { type ProjectInput, requireBigStr, requirePubkey } from './types.js';

/**
 * RewardsClaimed → `transactions` (kind='claim') + `claim_history`.
 *
 * Wire shape (`yield-distribution::RewardsClaimed`, camelCase post-persister):
 *   - claimant            (base58 wallet)
 *   - otMint              (base58 mint)
 *   - amount              (string bigint, claim delta)
 *   - cumulativeClaimed   (string bigint, running total per (wallet, ot_mint))
 *   - timestamp           (chain wall clock; we use the indexer block_time
 *                          instead so all projections share one time axis)
 */
@Injectable()
export class ClaimProjector {
  async project(manager: EntityManager, input: ProjectInput): Promise<void> {
    const wallet = requirePubkey(input.data, 'claimant');
    const otMint = requirePubkey(input.data, 'otMint');
    const amount = requireBigStr(input.data, 'amount');
    const cumulativeClaimed = requireBigStr(input.data, 'cumulativeClaimed');

    const txRow: Partial<Transaction> = {
      signature: input.meta.signature,
      logIndex: input.meta.logIndex,
      kind: 'claim',
      wallet,
      otMint,
      pool: null,
      amountA: amount,
      amountB: null,
      sharesDelta: null,
      blockTime: input.meta.blockTime,
      slot: String(input.meta.slot),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await manager.getRepository(Transaction).upsert(txRow as any, {
      conflictPaths: ['signature', 'logIndex'],
      skipUpdateIfNoValuesChanged: true,
    });

    const claimRow: Partial<ClaimHistory> = {
      signature: input.meta.signature,
      logIndex: input.meta.logIndex,
      wallet,
      otMint,
      amount,
      cumulativeClaimed,
      blockTime: input.meta.blockTime,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await manager.getRepository(ClaimHistory).upsert(claimRow as any, {
      conflictPaths: ['signature', 'logIndex'],
      skipUpdateIfNoValuesChanged: true,
    });
  }
}
