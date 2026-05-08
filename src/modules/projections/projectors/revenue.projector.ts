import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';

import { RevenueDistribution } from '../../../entities/revenue-distribution.entity.js';
import { type ProjectInput, requireBigStr, requireInt, requirePubkey } from './types.js';

/**
 * RevenueDistributed → `revenue_distributions`.
 *
 * Wire shape (`ownership-token::RevenueDistributed`, camelCase post-persister):
 *   - otMint              (base58)
 *   - totalAmount         (string bigint, distribution gross)
 *   - protocolFee         (string bigint, fee skim)
 *   - distributionCount   (u64 — string bigint; coerced to JS number for
 *                          column compatibility, never realistically exceeds
 *                          2^31 within service lifetime)
 *   - numDestinations     (u8 — JS number)
 *   - timestamp           (chain wall clock; we use indexer block_time)
 *
 * No wallet field — distribution fans out across all current OT-holders
 * inside the same instruction. Per-wallet revenue derives from the related
 * `RewardsClaimed` events (already in `claim_history`). This is also why
 * RevenueDistributed does NOT write to `transactions`.
 */
@Injectable()
export class RevenueProjector {
  async project(manager: EntityManager, input: ProjectInput): Promise<void> {
    const otMint = requirePubkey(input.data, 'otMint');
    const totalAmount = requireBigStr(input.data, 'totalAmount');
    const protocolFee = requireBigStr(input.data, 'protocolFee');
    const distributionCount = requireInt(input.data, 'distributionCount');
    const numDestinations = requireInt(input.data, 'numDestinations');

    const row: Partial<RevenueDistribution> = {
      signature: input.meta.signature,
      logIndex: input.meta.logIndex,
      otMint,
      totalAmount,
      protocolFee,
      distributionCount,
      numDestinations,
      blockTime: input.meta.blockTime,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await manager.getRepository(RevenueDistribution).upsert(row as any, {
      conflictPaths: ['signature', 'logIndex'],
      skipUpdateIfNoValuesChanged: true,
    });
  }
}
