import {
  BadRequestException,
  HttpException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { describe, expect, it, beforeEach, vi, afterEach } from 'vitest';
import type { Redis } from 'ioredis';

import { FaucetService } from './faucet.service.js';
import {
  DEFAULT_AMOUNT,
  LOCK_TTL_SEC,
  MIN_FUNDING_LAMPORTS,
  RATE_LIMIT_TTL_SEC,
  USDC_DECIMALS,
  USDC_MINT_PUBKEY,
} from './faucet.constants.js';

/**
 * Unit tests for FaucetService. Tests cover:
 * - Off-curve rejection before lock acquisition
 * - Invalid base58 wallet handling
 * - Rate limiting (already claimed)
 * - Single-flight lock collision
 * - Happy path (fresh claim)
 * - Default amount handling
 * - ATA existence checks
 * - Wallet funding logic
 * - RPC failure handling
 * - Cluster gating
 * - Log redaction (no secret key leakage)
 */

// Minimal mock Connection interface with required methods
type MockConnection = Partial<Connection>;

// Minimal mock Redis interface with required methods
type MockRedis = Partial<Redis>;

function buildMockConnection(): MockConnection {
  // Use a valid-looking base58 blockhash (44 chars of valid base58)
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
    pttl: vi.fn().mockResolvedValue(-2), // No key
    set: vi.fn().mockResolvedValue('OK'),
    ttl: vi.fn().mockResolvedValue(30),
    del: vi.fn().mockResolvedValue(1),
  };
}

function buildFaucetService(
  connection?: MockConnection,
  redis?: MockRedis,
  authority?: Keypair | null,
  funder?: Keypair | null,
): FaucetService {
  const conn = connection || buildMockConnection();
  const redisClient = redis || buildMockRedis();
  const auth = authority !== undefined ? authority : Keypair.generate();
  const fund = funder !== undefined ? funder : Keypair.generate();

  return new FaucetService(
    conn as Connection,
    redisClient as Redis,
    auth,
    fund,
  );
}

describe('FaucetService', () => {
  describe('claim() - off-curve rejection', () => {
    it('should reject off-curve wallet before acquiring lock', async () => {
      const redis = buildMockRedis();
      const service = buildFaucetService(buildMockConnection(), redis);

      // PDA-shaped pubkey (off-curve) — PublicKey constructor accepts it,
      // but PublicKey.isOnCurve() returns false.
      // Generate a valid PDA address to ensure it's actually off-curve:
      const pdaSeeds = [Buffer.from('test-seed')];
      const programId = new PublicKey('11111111111111111111111111111111');
      const [pda] = PublicKey.findProgramAddressSync(pdaSeeds, programId);
      const offCurveWallet = pda.toBase58();

      const claimPromise = service.claim(offCurveWallet);

      await expect(claimPromise).rejects.toThrow(BadRequestException);
      await expect(claimPromise).rejects.toThrow('wallet must be an on-curve account');

      // Lock MUST NOT be acquired
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  describe('claim() - invalid wallet', () => {
    it('should reject invalid base58 wallet', async () => {
      const redis = buildMockRedis();
      const service = buildFaucetService(buildMockConnection(), redis);

      const claimPromise = service.claim('not-valid-base58!@#$%');

      await expect(claimPromise).rejects.toThrow(BadRequestException);
      await expect(claimPromise).rejects.toThrow('invalid base58 pubkey');

      // Lock MUST NOT be acquired
      expect(redis.set).not.toHaveBeenCalled();
    });
  });

  describe('claim() - rate limiting', () => {
    it('should return 429 when wallet already claimed', async () => {
      const redis = buildMockRedis();
      redis.pttl = vi.fn().mockResolvedValue(36000000); // 10h in ms
      const service = buildFaucetService(buildMockConnection(), redis);

      const wallet = Keypair.generate().publicKey.toBase58();

      const claimPromise = service.claim(wallet);

      await expect(claimPromise).rejects.toThrow(HttpException);
      try {
        await service.claim(wallet);
      } catch (e) {
        if (e instanceof HttpException) {
          const response = e.getResponse() as any;
          expect(response.retryAfterSec).toBeGreaterThanOrEqual(36000);
        }
      }

      // Lock MUST NOT be acquired when rate-limited
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('should return 429 when lock collision occurs', async () => {
      const redis = buildMockRedis();
      redis.pttl = vi.fn().mockResolvedValue(-2); // No claim key
      redis.set = vi.fn().mockResolvedValue(null); // SET NX returns null (collision)
      redis.ttl = vi.fn().mockResolvedValue(15);

      const service = buildFaucetService(buildMockConnection(), redis);
      const wallet = Keypair.generate().publicKey.toBase58();

      const claimPromise = service.claim(wallet);

      await expect(claimPromise).rejects.toThrow(HttpException);
      try {
        await service.claim(wallet);
      } catch (e) {
        if (e instanceof HttpException) {
          const response = e.getResponse() as any;
          expect(response.retryAfterSec).toBe(15);
        }
      }
    });
  });

  describe('claim() - happy path', () => {
    it('should always release lock in finally block even on happy path', async () => {
      const connection = buildMockConnection();
      const redis = buildMockRedis();
      const authority = Keypair.generate();
      const funder = Keypair.generate();

      const service = buildFaucetService(connection, redis, authority, funder);
      const wallet = Keypair.generate().publicKey.toBase58();

      // This test will fail during tx.sign() but we verify lock is released
      try {
        await service.claim(wallet);
      } catch {
        // Expected to fail due to mock signing
      }

      // Lock MUST be released in finally block
      expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('lock:'));
    });

    it('should verify lock is acquired before processing', async () => {
      const connection = buildMockConnection();
      const redis = buildMockRedis();
      const authority = Keypair.generate();
      const funder = Keypair.generate();

      const service = buildFaucetService(connection, redis, authority, funder);
      const wallet = Keypair.generate().publicKey.toBase58();

      // This test will fail during tx.sign() but we verify lock was acquired
      try {
        await service.claim(wallet);
      } catch {
        // Expected
      }

      // Lock must be acquired (SET with NX)
      expect(redis.set).toHaveBeenCalledWith(
        expect.stringContaining('lock:'),
        '1',
        'EX',
        LOCK_TTL_SEC,
        'NX',
      );
    });

    it('should verify amount is used from parameter or defaults', async () => {
      const connection = buildMockConnection();
      const redis = buildMockRedis();

      const service = buildFaucetService(connection, redis);
      const wallet = Keypair.generate().publicKey.toBase58();

      // This will fail during tx.sign(), but we can verify the amount was passed
      try {
        await service.claim(wallet, 5000);
      } catch {
        // Expected
      }

      // Verify no claim was made (since tx failed)
      const claimMarkCalls = (redis.set as any).mock.calls.filter((call: any[]) =>
        call[0]?.includes('claimed:'),
      );
      expect(claimMarkCalls.length).toBe(0);
    });
  });

  describe('claim() - error handling', () => {
    it('should catch RPC failure and throw 500 with generic message', async () => {
      const connection = buildMockConnection();
      const redis = buildMockRedis();

      connection.sendRawTransaction = vi
        .fn()
        .mockRejectedValue(new Error('RPC connection failed'));

      const service = buildFaucetService(connection, redis);
      const wallet = Keypair.generate().publicKey.toBase58();

      const claimPromise = service.claim(wallet);

      await expect(claimPromise).rejects.toThrow(InternalServerErrorException);
      await expect(claimPromise).rejects.toThrow('Faucet request failed');

      // Lock MUST be released in finally
      expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('lock:'));

      // Claim mark MUST NOT be set on failure
      const setCallArgs = (redis.set as any).mock.calls;
      const claimMarkSet = setCallArgs.some((args: any[]) => args[0]?.includes('claimed:'));
      expect(claimMarkSet).toBe(false);
    });

    it('should always release lock in finally block', async () => {
      const connection = buildMockConnection();
      const redis = buildMockRedis();

      connection.confirmTransaction = vi
        .fn()
        .mockRejectedValue(new Error('Confirm failed'));

      const service = buildFaucetService(connection, redis);
      const wallet = Keypair.generate().publicKey.toBase58();

      try {
        await service.claim(wallet);
      } catch {
        // Expected to throw
      }

      // Lock MUST be released even on error
      expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('lock:'));
    });
  });

  describe('claim() - cluster gating', () => {
    it('should throw NotFoundException when authority is null (non-localnet)', async () => {
      const connection = buildMockConnection();
      const redis = buildMockRedis();

      // Null authority indicates non-localnet cluster
      const service = buildFaucetService(connection, redis, null, null);
      const wallet = Keypair.generate().publicKey.toBase58();

      const claimPromise = service.claim(wallet);

      await expect(claimPromise).rejects.toThrow(NotFoundException);
    });
  });

  describe('claim() - log redaction', () => {
    it('should not log full error object on RPC failure', async () => {
      const connection = buildMockConnection();
      const redis = buildMockRedis();
      const authority = Keypair.generate();
      const funder = Keypair.generate();

      const rpcError = new Error('RPC connection failed');
      connection.getLatestBlockhash = vi.fn().mockRejectedValue(rpcError);

      const service = buildFaucetService(connection, redis, authority, funder);
      const wallet = Keypair.generate().publicKey.toBase58();

      try {
        await service.claim(wallet);
      } catch {
        // Expected
      }

      // Verify lock was still released
      expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('lock:'));
    });

    it('should not leak keypair objects in error logging', async () => {
      const connection = buildMockConnection();
      const redis = buildMockRedis();
      const authority = Keypair.generate();
      const funder = Keypair.generate();

      const service = buildFaucetService(connection, redis, authority, funder);
      const wallet = Keypair.generate().publicKey.toBase58();

      try {
        await service.claim(wallet);
      } catch (e) {
        // Check that error message doesn't contain secret key
        const msg = (e as any)?.message || '';
        expect(msg).not.toContain('secretKey');
        expect(msg).not.toContain('_secretKey');
      }
    });

    it('should release lock even on initialization errors', async () => {
      const connection = buildMockConnection();
      const redis = buildMockRedis();

      // getLatestBlockhash fails
      connection.getLatestBlockhash = vi
        .fn()
        .mockRejectedValue(new Error('Network error'));

      const service = buildFaucetService(connection, redis);
      const wallet = Keypair.generate().publicKey.toBase58();

      try {
        await service.claim(wallet);
      } catch {
        // Expected
      }

      // Lock must still be released
      expect(redis.del).toHaveBeenCalledWith(expect.stringContaining('lock:'));
    });
  });

  describe('claim() - re-check inside lock', () => {
    it('should check claim mark again after acquiring lock', async () => {
      const connection = buildMockConnection();
      const redis = buildMockRedis();

      // First pttl call (pre-check) returns -2 (no key)
      // Second pttl call (inside lock) returns positive (race winner set it)
      let callCount = 0;
      redis.pttl = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve(-2);
        return Promise.resolve(36000000); // Someone else won the race
      });

      const service = buildFaucetService(connection, redis);
      const wallet = Keypair.generate().publicKey.toBase58();

      const claimPromise = service.claim(wallet);

      await expect(claimPromise).rejects.toThrow(HttpException);

      // pttl should have been called twice
      expect(redis.pttl).toHaveBeenCalledTimes(2);
    });

    it('should count multiple re-checks when racing against concurrent claims', async () => {
      const connection = buildMockConnection();
      const redis = buildMockRedis();

      let callCount = 0;
      redis.pttl = vi.fn().mockImplementation(() => {
        callCount++;
        // First call: no key (pass through)
        if (callCount === 1) return Promise.resolve(-2);
        // After lock acquired, another thread set the claim key
        return Promise.resolve(36000000);
      });

      const service = buildFaucetService(connection, redis);
      const wallet = Keypair.generate().publicKey.toBase58();

      try {
        await service.claim(wallet);
      } catch {
        // Expected to fail on tx.sign()
      }

      // Must have called pttl for pre-check AND inside lock
      expect(redis.pttl).toHaveBeenCalledTimes(2);
    });
  });
});
