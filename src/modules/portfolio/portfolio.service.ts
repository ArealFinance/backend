import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

import { ClaimHistory } from '../../entities/claim-history.entity.js';
import { LpPositionHistory } from '../../entities/lp-position-history.entity.js';
import { decodeCursor, encodeCursor } from '../transactions/cursor.js';
import type { ListClaimsDto, ListClaimsResponseDto } from './dto/list-claims.dto.js';
import type {
  ListLpPositionsDto,
  ListLpPositionsResponseDto,
} from './dto/list-lp-positions.dto.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/**
 * Per-wallet portfolio history. Uses the same opaque cursor format as
 * `/transactions` (encoded in `transactions/cursor.ts`) so the frontend can
 * share one decode helper.
 */
@Injectable()
export class PortfolioService {
  constructor(
    @InjectRepository(ClaimHistory) private readonly claims: Repository<ClaimHistory>,
    @InjectRepository(LpPositionHistory)
    private readonly lpHistory: Repository<LpPositionHistory>,
  ) {}

  async listClaims(wallet: string, query: ListClaimsDto): Promise<ListClaimsResponseDto> {
    const limit = clampLimit(query.limit);

    const qb = this.claims.createQueryBuilder('c').where('c.wallet = :wallet', { wallet });
    if (query.ot) qb.andWhere('c.ot_mint = :ot', { ot: query.ot });
    applyBefore(qb, query.before, 'c');

    const rows = await qb
      .orderBy('c.block_time', 'DESC')
      .addOrderBy('c.signature', 'DESC')
      .addOrderBy('c.log_index', 'DESC')
      .limit(limit + 1)
      .getMany();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: page.map((r) => ({
        signature: r.signature,
        logIndex: r.logIndex,
        wallet: r.wallet,
        otMint: r.otMint,
        amount: r.amount,
        cumulativeClaimed: r.cumulativeClaimed,
        blockTime: r.blockTime.toISOString(),
      })),
      nextCursor: hasMore && page.length > 0 ? cursorOf(page[page.length - 1]!) : null,
    };
  }

  async listLpPositions(
    wallet: string,
    query: ListLpPositionsDto,
  ): Promise<ListLpPositionsResponseDto> {
    const limit = clampLimit(query.limit);

    const qb = this.lpHistory.createQueryBuilder('l').where('l.wallet = :wallet', { wallet });
    if (query.pool) qb.andWhere('l.pool = :pool', { pool: query.pool });
    applyBefore(qb, query.before, 'l');

    const rows = await qb
      .orderBy('l.block_time', 'DESC')
      .addOrderBy('l.signature', 'DESC')
      .addOrderBy('l.log_index', 'DESC')
      .limit(limit + 1)
      .getMany();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      items: page.map((r) => ({
        signature: r.signature,
        logIndex: r.logIndex,
        wallet: r.wallet,
        pool: r.pool,
        kind: r.kind,
        amountA: r.amountA,
        amountB: r.amountB,
        sharesDelta: r.sharesDelta,
        blockTime: r.blockTime.toISOString(),
      })),
      nextCursor: hasMore && page.length > 0 ? cursorOf(page[page.length - 1]!) : null,
    };
  }
}

function clampLimit(n: number | undefined): number {
  return Math.min(Math.max(n ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
}

function cursorOf(row: { blockTime: Date; signature: string; logIndex: number }): string {
  return encodeCursor({
    blockTimeMs: row.blockTime.getTime(),
    signature: row.signature,
    logIndex: row.logIndex,
  });
}

function applyBefore(
  qb: SelectQueryBuilder<ObjectLiteral>,
  before: string | undefined,
  alias: string,
): void {
  if (!before) return;
  let cursor;
  try {
    cursor = decodeCursor(before);
  } catch (err) {
    throw new BadRequestException(err instanceof Error ? err.message : 'invalid cursor');
  }
  qb.andWhere(`(${alias}.block_time, ${alias}.signature, ${alias}.log_index) < (:bt, :sig, :li)`, {
    bt: new Date(cursor.blockTimeMs),
    sig: cursor.signature,
    li: cursor.logIndex,
  });
}
