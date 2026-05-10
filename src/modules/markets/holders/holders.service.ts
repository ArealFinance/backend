import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Connection, PublicKey } from '@solana/web3.js';
import type { Redis } from 'ioredis';

import { SOLANA_CONNECTION } from '../../../common/solana/connection.module.js';
import { MARKETS_REDIS } from './markets-redis.provider.js';

/**
 * SPL token account layout: 165 bytes total. The `mint` field is the first
 * 32 bytes (offset 0), `amount` is a little-endian u64 starting at byte 64.
 *
 *   offset  size  field
 *   ------  ----  -----
 *        0    32  mint
 *       32    32  owner
 *       64     8  amount (LE u64)
 *       72     ...
 *
 * We slice only the 8 amount bytes via `dataSlice` to keep the RPC payload
 * minimal — for a popular mint with tens of thousands of holders the full
 * 165-byte account dump would be hundreds of KB.
 */
const SPL_TOKEN_ACCOUNT_SIZE = 165;
const AMOUNT_OFFSET = 64;
const AMOUNT_BYTES = 8;

/** 5 minutes — long enough to absorb dashboard polling, short enough to feel live. */
const CACHE_TTL_S = 300;
const CACHE_KEY = (mint: string): string => `areal:markets:holders:${mint}`;

/**
 * SPL Token Program ID — pinned canonical value. Backend does not depend on
 * `@areal/sdk` as a workspace package (verified via package.json), so the
 * constant is hardcoded here. If/when the SDK is wired in as a dep, swap
 * for an import from `@areal/sdk/network/constants`.
 */
const SPL_TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

interface HoldersPayload {
  mint: string;
  count: number;
  updatedAt: string;
}

export interface HoldersResult extends HoldersPayload {
  source: 'rpc' | 'cache';
}

/**
 * Reads the live unique holder count for an SPL mint via
 * `getProgramAccounts` against the SPL Token Program, filtered by mint.
 *
 * Costly RPC call — every result is cached in Redis for `CACHE_TTL_S`. We
 * deliberately do NOT cache failures: an upstream blip should not poison
 * the cache for 5 minutes, so the next request retries instead.
 */
@Injectable()
export class HoldersService {
  private readonly logger = new Logger(HoldersService.name);

  constructor(
    @Inject(SOLANA_CONNECTION) private readonly conn: Connection,
    @Inject(MARKETS_REDIS) private readonly redis: Redis,
  ) {}

  async getHolders(mint: string): Promise<HoldersResult> {
    const key = CACHE_KEY(mint);
    const cached = await this.redis.get(key);
    if (cached) {
      this.logger.log(`cache hit mint=${mint}`);
      const parsed = JSON.parse(cached) as HoldersPayload;
      return { ...parsed, source: 'cache' };
    }

    this.logger.log(`cache miss mint=${mint} — querying RPC`);
    let pk: PublicKey;
    try {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      pk = new PublicKey(mint);
    } catch (e) {
      // Defense-in-depth — controller's regex guard should prevent this.
      throw new Error(`invalid mint: ${(e as Error).message}`);
    }
    // Reference `pk` so its construction validates the input and the var is
    // not flagged as unused under strict TS settings.
    void pk;

    let count = 0;
    try {
      const t0 = Date.now();
      const accounts = await this.conn.getProgramAccounts(SPL_TOKEN_PROGRAM_ID, {
        commitment: 'confirmed',
        filters: [{ dataSize: SPL_TOKEN_ACCOUNT_SIZE }, { memcmp: { offset: 0, bytes: mint } }],
        dataSlice: { offset: AMOUNT_OFFSET, length: AMOUNT_BYTES },
      });
      const dt = Date.now() - t0;
      for (const { account } of accounts) {
        const buf = account.data;
        // Avoid BigInt allocation — exclude-zero check via two u32 reads.
        // Little-endian u64 is two consecutive LE u32s; either non-zero
        // means amount > 0.
        const lo = buf.readUInt32LE(0);
        const hi = buf.readUInt32LE(4);
        if (lo !== 0 || hi !== 0) count++;
      }
      this.logger.log(`RPC ok mint=${mint} count=${count} accounts=${accounts.length} dt=${dt}ms`);
    } catch (e) {
      this.logger.error(
        `holders RPC failed mint=${mint} err=${(e as Error).message}`,
        (e as Error).stack,
      );
      // CRITICAL: Do NOT write to cache on failure — a transient RPC error
      // would otherwise be served as a stale "0 holders" for 5 minutes.
      throw new ServiceUnavailableException('upstream RPC failed');
    }

    const payload: HoldersPayload = { mint, count, updatedAt: new Date().toISOString() };
    await this.redis.set(key, JSON.stringify(payload), 'EX', CACHE_TTL_S);
    return { ...payload, source: 'rpc' };
  }
}
