import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Transaction } from '../../entities/transaction.entity.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import type { ListTransactionsDto } from './dto/list-transactions.dto.js';
import type { ListTransactionsResponseDto, TransactionRowDto } from './dto/transaction-row.dto.js';

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

@Injectable()
export class TransactionsService {
  constructor(
    @InjectRepository(Transaction) private readonly transactions: Repository<Transaction>,
  ) {}

  async list(query: ListTransactionsDto): Promise<ListTransactionsResponseDto> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);

    // Build the keyset condition. We sort DESC by (block_time, signature, log_index)
    // and ask for everything strictly older. Tie-break on signature/log_index
    // so identical block_time pages don't repeat rows on the boundary.
    const qb = this.transactions
      .createQueryBuilder('t')
      .where('t.wallet = :wallet', { wallet: query.wallet });

    if (query.kind) qb.andWhere('t.kind = :kind', { kind: query.kind });

    if (query.before) {
      let cursor;
      try {
        cursor = decodeCursor(query.before);
      } catch (err) {
        throw new BadRequestException(err instanceof Error ? err.message : 'invalid cursor');
      }
      qb.andWhere(
        // Lexicographic "older than" on the (block_time, signature, log_index) tuple.
        // ROW(...) is supported by Postgres directly and uses the composite index
        // when the planner sees fit; for our index `(wallet, block_time)` the leading
        // wallet equality + block_time range still resolves index-only.
        '(t.block_time, t.signature, t.log_index) < (:bt, :sig, :li)',
        {
          bt: new Date(cursor.blockTimeMs),
          sig: cursor.signature,
          li: cursor.logIndex,
        },
      );
    }

    const rows = await qb
      .orderBy('t.block_time', 'DESC')
      .addOrderBy('t.signature', 'DESC')
      .addOrderBy('t.log_index', 'DESC')
      .limit(limit + 1) // fetch one extra to detect "has next page"
      .getMany();

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const items: TransactionRowDto[] = page.map((r) => ({
      signature: r.signature,
      logIndex: r.logIndex,
      kind: r.kind,
      wallet: r.wallet,
      otMint: r.otMint,
      pool: r.pool,
      amountA: r.amountA,
      amountB: r.amountB,
      sharesDelta: r.sharesDelta,
      blockTime: r.blockTime.toISOString(),
      slot: r.slot,
    }));

    let nextCursor: string | null = null;
    if (hasMore && page.length > 0) {
      const last = page[page.length - 1]!;
      nextCursor = encodeCursor({
        blockTimeMs: last.blockTime.getTime(),
        signature: last.signature,
        logIndex: last.logIndex,
      });
    }

    return { items, nextCursor };
  }
}
