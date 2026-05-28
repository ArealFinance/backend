import {
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

import { RwtFaucetService } from './rwt-faucet.service.js';
import { LOCK_TTL_SEC } from './faucet.constants.js';

/**
 * Unit tests for RwtFaucetService. Mirrors faucet.service.spec.ts and
 * adds RWT-specific assertions:
 *   - Cluster gating (null treasury -> 404)
 *   - Redis key namespace (faucet:rwt:lock / faucet:rwt:claimed)
 *   - Happy-path lock acquire + release
 *   - Off-curve rejection before lock
 *   - Rate-limit re-check inside lock
 */

type MockConnection = Partial<Connection>;
type MockRedis = Partial<Redis>;

function buildMockConnection(): MockConnection {
  const validBlockhash = '11111111111111111111111111111111111111111111';
  return {
    getAccountInfo: vi.fn().mockResolvedValue(null),
    getBalance: vi.fn().mockResolvedValue(0),
    getLatestBlockhash: vi
      .fn()
      .mockResolvedValue({ blockhash: validBlockhash, lastValidBlockHeight: 100 }),
    sendRawTransaction: vi.fn().mockResolvedValue('11111111111111111111111111111111111111111111'),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
  };
}

function buildMockRedis(): MockRedis {
  return {
    pttl: vi.fn().mockResolvedValue(-2),
    set: vi.fn().mockResolvedValue('OK'),
    ttl: vi.fn().mockResolvedValue(30),
    del: vi.fn().mockResolvedValue(1),
  };
}

function buildService(
  connection?: MockConnection,
  redis?: MockRedis,
  treasury?: Keypair | null,
  funder?: Keypair | null,
): RwtFaucetService {
  const conn = connection || buildMockConnection();
  const redisClient = redis || buildMockRedis();
  const t = treasury !== undefined ? treasury : Keypair.generate();
  const f = funder !== undefined ? funder : Keypair.generate();
  return new RwtFaucetService(conn as Connection, redisClient as Redis, t, f);
}

describe('RwtFaucetService', () => {
  describe('claimRwt() - cluster gating', () => {
    it('should throw NotFoundException when treasury is null', async () => {
      const service = buildService(undefined, undefined, null, null);
      const wallet = Keypair.generate().publicKey.toBase58();
      await expect(service.claimRwt(wallet)).rejects.toThrow(NotFoundException);
    });

    it('should throw NotFoundException when funder is null (partial config)', async () => {
      const service = buildService(undefined, undefined, Keypair.generate(), null);
      const wallet = Keypair.generate().publicKey.toBase58();
      await expect(service.claimRwt(wallet)).rejects.toThrow(NotFoundException);
    });
  });

  describe('claimRwt() - input validation', () => {
    it('should reject invalid base58 wallet', async () => {
      const redis = buildMockRedis();
      const service = buildService(buildMockConnection(), redis);
      await expect(service.claimRwt('not-valid-base58!@#$%')).rejects.toThrow(BadRequestException);
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('should reject off-curve wallet before acquiring lock', async () => {
      const redis = buildMockRedis();
      const service = buildService(buildMockConnection(), redis);

      const programId = new PublicKey('11111111111111111111111111111111');
      const [pda] = PublicKey.findProgramAddressSync([Buffer.from('seed')], programId);
      const offCurve = pda.toBase58();

      const p = service.claimRwt(offCurve);
      await expect(p).rejects.toThrow(BadRequestException);
      await expect(p).rejects.toThrow('wallet must be an on-curve account');
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  describe('claimRwt() - rate limiting', () => {
    it('should return 429 when wallet already claimed (pre-check)', async () => {
      const redis = buildMockRedis();
      redis.pttl = vi.fn().mockResolvedValue(36000000); // 10h in ms
      const service = buildService(buildMockConnection(), redis);
      const wallet = Keypair.generate().publicKey.toBase58();

      await expect(service.claimRwt(wallet)).rejects.toThrow(HttpException);

      // Lock MUST NOT be acquired when rate-limited
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('should return 429 when lock collision occurs', async () => {
      const redis = buildMockRedis();
      redis.pttl = vi.fn().mockResolvedValue(-2);
      redis.set = vi.fn().mockResolvedValue(null); // NX collision
      redis.ttl = vi.fn().mockResolvedValue(15);

      const service = buildService(buildMockConnection(), redis);
      const wallet = Keypair.generate().publicKey.toBase58();

      try {
        await service.claimRwt(wallet);
        throw new Error('expected throw');
      } catch (e) {
        expect(e).toBeInstanceOf(HttpException);
        const response = (e as HttpException).getResponse() as any;
        expect(response.retryAfterSec).toBe(15);
      }
    });

    it('should re-check claim mark after acquiring lock (race close)', async () => {
      const redis = buildMockRedis();
      let calls = 0;
      redis.pttl = vi.fn().mockImplementation(() => {
        calls++;
        if (calls === 1) return Promise.resolve(-2);
        return Promise.resolve(36000000);
      });

      const service = buildService(buildMockConnection(), redis);
      const wallet = Keypair.generate().publicKey.toBase58();

      await expect(service.claimRwt(wallet)).rejects.toThrow(HttpException);
      expect(redis.pttl).toHaveBeenCalledTimes(2);
    });
  });

  describe('claimRwt() - Redis key namespace', () => {
    it('should use faucet:rwt:lock:<wallet> key for lock', async () => {
      const redis = buildMockRedis();
      const service = buildService(buildMockConnection(), redis);
      const wallet = Keypair.generate().publicKey.toBase58();

      try {
        await service.claimRwt(wallet);
      } catch {
        // Tx will fail in mocks; we only assert key naming
      }

      const setCalls = (redis.set as any).mock.calls;
      const lockCall = setCalls.find((args: any[]) => args[0]?.includes(':lock:'));
      expect(lockCall).toBeDefined();
      expect(lockCall![0]).toBe(`faucet:rwt:lock:${wallet}`);
      expect(lockCall![1]).toBe('1');
      expect(lockCall![2]).toBe('EX');
      expect(lockCall![3]).toBe(LOCK_TTL_SEC);
      expect(lockCall![4]).toBe('NX');
    });

    it('should query faucet:rwt:claimed:<wallet> for rate-limit check', async () => {
      const redis = buildMockRedis();
      const service = buildService(buildMockConnection(), redis);
      const wallet = Keypair.generate().publicKey.toBase58();

      try {
        await service.claimRwt(wallet);
      } catch {
        // Tx will fail; we only assert pttl key
      }

      expect(redis.pttl).toHaveBeenCalledWith(`faucet:rwt:claimed:${wallet}`);
    });
  });

  describe('claimRwt() - lock release', () => {
    it('should release lock in finally on RPC failure', async () => {
      const connection = buildMockConnection();
      connection.sendRawTransaction = vi.fn().mockRejectedValue(new Error('RPC failed'));
      const redis = buildMockRedis();
      const service = buildService(connection, redis);
      const wallet = Keypair.generate().publicKey.toBase58();

      await expect(service.claimRwt(wallet)).rejects.toThrow(InternalServerErrorException);
      expect(redis.del).toHaveBeenCalledWith(expect.stringContaining(':lock:'));
    });

    it('should NOT set claim mark on tx failure', async () => {
      const connection = buildMockConnection();
      connection.sendRawTransaction = vi.fn().mockRejectedValue(new Error('boom'));
      const redis = buildMockRedis();
      const service = buildService(connection, redis);
      const wallet = Keypair.generate().publicKey.toBase58();

      try {
        await service.claimRwt(wallet);
      } catch {
        // Expected
      }

      const claimedCalls = (redis.set as any).mock.calls.filter((args: any[]) =>
        args[0]?.includes(':claimed:'),
      );
      expect(claimedCalls.length).toBe(0);
    });
  });
});
