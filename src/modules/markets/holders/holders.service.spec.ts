import { ServiceUnavailableException } from '@nestjs/common';
import type { Connection } from '@solana/web3.js';
import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { HoldersService } from './holders.service.js';

const VALID_MINT = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';

/**
 * Build a stub Buffer carrying an LE u64 amount in its first 8 bytes.
 * The service slices `dataSlice.length = 8` so the test buffers mirror
 * what the RPC actually returns over the wire.
 */
function amountBuf(loU32: number, hiU32 = 0): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeUInt32LE(loU32, 0);
  buf.writeUInt32LE(hiU32, 4);
  return buf;
}

function makeAccounts(...amounts: Buffer[]): Array<{ pubkey: unknown; account: { data: Buffer } }> {
  return amounts.map((data, i) => ({ pubkey: `acc-${i}`, account: { data } }));
}

function makeConn(getProgramAccounts: ReturnType<typeof vi.fn>): Connection {
  return { getProgramAccounts } as unknown as Connection;
}

function makeRedis(
  overrides: Partial<{ get: ReturnType<typeof vi.fn>; set: ReturnType<typeof vi.fn> }> = {},
): {
  redis: Redis;
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
} {
  const get = overrides.get ?? vi.fn().mockResolvedValue(null);
  const set = overrides.set ?? vi.fn().mockResolvedValue('OK');
  return { redis: { get, set } as unknown as Redis, get, set };
}

describe('HoldersService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('cache hit returns source=cache without RPC call', async () => {
    const cached = JSON.stringify({
      mint: VALID_MINT,
      count: 42,
      updatedAt: '2026-05-10T00:00:00.000Z',
    });
    const { redis, get, set } = makeRedis({ get: vi.fn().mockResolvedValue(cached) });
    const getProgramAccounts = vi.fn();
    const conn = makeConn(getProgramAccounts);
    const svc = new HoldersService(conn, redis);

    const result = await svc.getHolders(VALID_MINT);

    expect(get).toHaveBeenCalledWith(`areal:markets:holders:${VALID_MINT}`);
    expect(getProgramAccounts).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(result).toEqual({
      mint: VALID_MINT,
      count: 42,
      updatedAt: '2026-05-10T00:00:00.000Z',
      source: 'cache',
    });
  });

  it('cache miss queries RPC then writes cache with EX 300', async () => {
    const { redis, set } = makeRedis();
    const getProgramAccounts = vi.fn().mockResolvedValue(makeAccounts(amountBuf(1), amountBuf(5)));
    const conn = makeConn(getProgramAccounts);
    const svc = new HoldersService(conn, redis);

    const result = await svc.getHolders(VALID_MINT);

    expect(getProgramAccounts).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledTimes(1);
    const setArgs = set.mock.calls[0]!;
    expect(setArgs[0]).toBe(`areal:markets:holders:${VALID_MINT}`);
    const payload = JSON.parse(setArgs[1] as string) as { mint: string; count: number };
    expect(payload.mint).toBe(VALID_MINT);
    expect(payload.count).toBe(2);
    expect(setArgs[2]).toBe('EX');
    expect(setArgs[3]).toBe(300);
    expect(result.source).toBe('rpc');
    expect(result.count).toBe(2);
  });

  it('getProgramAccounts called with dataSize 165, memcmp offset 0 bytes mint, dataSlice offset 64 length 8', async () => {
    const { redis } = makeRedis();
    const getProgramAccounts = vi.fn().mockResolvedValue([]);
    const conn = makeConn(getProgramAccounts);
    const svc = new HoldersService(conn, redis);

    await svc.getHolders(VALID_MINT);

    expect(getProgramAccounts).toHaveBeenCalledTimes(1);
    const [, opts] = getProgramAccounts.mock.calls[0] as [
      unknown,
      {
        commitment: string;
        filters: Array<{ dataSize?: number; memcmp?: { offset: number; bytes: string } }>;
        dataSlice: { offset: number; length: number };
      },
    ];
    expect(opts.commitment).toBe('confirmed');
    expect(opts.filters).toEqual([{ dataSize: 165 }, { memcmp: { offset: 0, bytes: VALID_MINT } }]);
    expect(opts.dataSlice).toEqual({ offset: 64, length: 8 });
  });

  it('counts only accounts with amount > 0 (3 non-zero, 1 zero -> count=3)', async () => {
    const { redis } = makeRedis();
    const accounts = makeAccounts(
      amountBuf(1),
      amountBuf(0, 1), // hi non-zero
      amountBuf(0, 0), // zero — must be skipped
      amountBuf(99),
    );
    const getProgramAccounts = vi.fn().mockResolvedValue(accounts);
    const svc = new HoldersService(makeConn(getProgramAccounts), redis);

    const result = await svc.getHolders(VALID_MINT);

    expect(result.count).toBe(3);
  });

  it('decodes amount as little-endian u64 (single account 01 00 00 00 00 00 00 00)', async () => {
    const { redis } = makeRedis();
    // Explicit byte pattern: 0x01 in LE u64 = amount 1, must count as a holder.
    const buf = Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
    const getProgramAccounts = vi.fn().mockResolvedValue(makeAccounts(buf));
    const svc = new HoldersService(makeConn(getProgramAccounts), redis);

    const result = await svc.getHolders(VALID_MINT);

    expect(result.count).toBe(1);
  });

  it('RPC failure throws ServiceUnavailableException', async () => {
    const { redis } = makeRedis();
    const getProgramAccounts = vi.fn().mockRejectedValue(new Error('rpc down'));
    const svc = new HoldersService(makeConn(getProgramAccounts), redis);

    await expect(svc.getHolders(VALID_MINT)).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('RPC failure does NOT call redis.set', async () => {
    const { redis, set } = makeRedis();
    const getProgramAccounts = vi.fn().mockRejectedValue(new Error('rpc down'));
    const svc = new HoldersService(makeConn(getProgramAccounts), redis);

    await expect(svc.getHolders(VALID_MINT)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(set).not.toHaveBeenCalled();
  });
});
