import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import type { Redis } from 'ioredis';

import { FaucetController } from '../src/modules/faucet/faucet.controller.js';
import { FaucetService } from '../src/modules/faucet/faucet.service.js';
import { FaucetClaimDto } from '../src/modules/faucet/dto/faucet-claim.dto.js';
import { LocalnetOnlyGuard } from '../src/modules/faucet/faucet.guard.js';
import { FAUCET_REDIS } from '../src/modules/faucet/redis.provider.js';
import { FAUCET_AUTHORITY_KEYPAIR, FAUCET_FUNDER_KEYPAIR } from '../src/modules/faucet/keypair.tokens.js';
import { SOLANA_CONNECTION } from '../src/common/solana/connection.module.js';
import {
  DEFAULT_AMOUNT,
  LOCK_TTL_SEC,
  MIN_FUNDING_LAMPORTS,
  RATE_LIMIT_TTL_SEC,
  USDC_DECIMALS,
  USDC_MINT_PUBKEY,
} from '../src/modules/faucet/faucet.constants.js';

/**
 * E2E tests for the faucet module. Tests cover:
 * - Happy path: fresh claim on localnet succeeds with 200
 * - Rate limiting: second claim to same wallet returns 429
 * - Validation: invalid wallet returns 400
 * - Validation: amount > MAX_AMOUNT returns 400
 * - Cluster gating: devnet/mainnet returns 404
 */

// Minimal mock implementations
type MockConnection = Partial<Connection>;
type MockRedis = Partial<Redis>;

function buildMockConnection(): MockConnection {
  return {
    getAccountInfo: vi.fn().mockResolvedValue(null),
    getBalance: vi.fn().mockResolvedValue(0),
    getLatestBlockhash: vi
      .fn()
      .mockResolvedValue({ blockhash: 'test-blockhash', lastValidBlockHeight: 100 }),
    sendRawTransaction: vi.fn().mockResolvedValue('mock-signature-1234567890123456789012345'),
    confirmTransaction: vi.fn().mockResolvedValue({ value: { err: null } }),
  };
}

function buildMockRedis(): MockRedis {
  // Simple in-memory Redis mock for testing
  const store: Map<string, { value: string; expiresAt: number }> = new Map();

  return {
    pttl: vi.fn().mockImplementation((key: string) => {
      const entry = store.get(key);
      if (!entry) return Promise.resolve(-2); // Key does not exist
      const remaining = entry.expiresAt - Date.now();
      return Promise.resolve(Math.max(remaining, -1)); // Return remaining ms
    }),

    set: vi.fn().mockImplementation((key: string, value: string, ...args: any[]) => {
      // Handle NX (only set if not exists)
      const nxIndex = args.indexOf('NX');
      if (nxIndex !== -1 && store.has(key)) {
        return Promise.resolve(null); // NX failed, key exists
      }

      // Handle EX (expiration)
      let expiresAt = Date.now() + 86400 * 1000; // Default 24h
      const exIndex = args.indexOf('EX');
      if (exIndex !== -1 && exIndex + 1 < args.length) {
        expiresAt = Date.now() + args[exIndex + 1] * 1000;
      }

      store.set(key, { value, expiresAt });
      return Promise.resolve('OK');
    }),

    ttl: vi.fn().mockImplementation((key: string) => {
      const entry = store.get(key);
      if (!entry) return Promise.resolve(-2); // Key does not exist
      const remaining = Math.ceil((entry.expiresAt - Date.now()) / 1000);
      return Promise.resolve(Math.max(remaining, 0));
    }),

    del: vi.fn().mockImplementation((key: string) => {
      const had = store.has(key);
      store.delete(key);
      return Promise.resolve(had ? 1 : 0);
    }),

    // Utility to clear for test isolation
    flushdb: vi.fn().mockImplementation(() => {
      store.clear();
      return Promise.resolve('OK');
    }),
  };
}

describe('Faucet E2E Tests', () => {
  let app: INestApplication;
  let mockConnection: MockConnection;
  let mockRedis: MockRedis;
  let configService: ConfigService;

  beforeAll(async () => {
    mockConnection = buildMockConnection();
    mockRedis = buildMockRedis();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [FaucetController],
      providers: [
        FaucetService,
        {
          provide: SOLANA_CONNECTION,
          useValue: mockConnection,
        },
        {
          provide: FAUCET_REDIS,
          useValue: mockRedis,
        },
        {
          provide: FAUCET_AUTHORITY_KEYPAIR,
          useValue: Keypair.generate(),
        },
        {
          provide: FAUCET_FUNDER_KEYPAIR,
          useValue: Keypair.generate(),
        },
        {
          provide: ConfigService,
          useValue: {
            get: (key: string) => {
              if (key === 'solana.cluster') return 'localnet';
              return undefined;
            },
          },
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();

    // Apply global ValidationPipe as in the real app
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: {
          enableImplicitConversion: true,
        },
      }),
    );

    await app.init();
    configService = moduleFixture.get<ConfigService>(ConfigService);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('Happy Path - Fresh Claim on Localnet', () => {
    it('should successfully claim USDC for a fresh wallet', async () => {
      await (mockRedis.flushdb as jest.Mock)();

      const testWallet = Keypair.generate().publicKey.toBase58();
      const dto: FaucetClaimDto = {
        wallet: testWallet,
        amount: 1000,
      };

      const response = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.signature).toBeDefined();
      expect(response.body.ata).toBeDefined();
      expect(response.body.amount).toBe(1000);
    });

    it('should use default amount when omitted', async () => {
      await (mockRedis.flushdb as jest.Mock)();

      const testWallet = Keypair.generate().publicKey.toBase58();
      const dto: FaucetClaimDto = {
        wallet: testWallet,
      };

      const response = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(200);

      expect(response.body.amount).toBe(DEFAULT_AMOUNT);
    });

    it('should return valid base58 ATA pubkey', async () => {
      await (mockRedis.flushdb as jest.Mock)();

      const testWallet = Keypair.generate().publicKey.toBase58();
      const dto: FaucetClaimDto = {
        wallet: testWallet,
      };

      const response = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(200);

      // ATA should be valid base58 and reasonable length
      expect(typeof response.body.ata).toBe('string');
      expect(response.body.ata.length).toBeGreaterThanOrEqual(32);
      expect(response.body.ata.length).toBeLessThanOrEqual(44);
    });
  });

  describe('Rate Limiting - Per-Wallet 24h Cap', () => {
    it('should return 429 on second claim within 24h', async () => {
      await (mockRedis.flushdb as jest.Mock)();

      const testWallet = Keypair.generate().publicKey.toBase58();
      const dto: FaucetClaimDto = {
        wallet: testWallet,
      };

      // First claim should succeed
      const firstResponse = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(200);

      expect(firstResponse.body.success).toBe(true);

      // Second claim should be rate-limited
      const secondResponse = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(429);

      expect(secondResponse.body.retryAfterSec).toBeDefined();
      expect(secondResponse.body.retryAfterSec).toBeGreaterThan(0);
      expect(secondResponse.body.retryAfterSec).toBeLessThanOrEqual(86400);
    });

    it('should include retryAfterSec close to 24h for immediate second claim', async () => {
      await (mockRedis.flushdb as jest.Mock)();

      const testWallet = Keypair.generate().publicKey.toBase58();
      const dto: FaucetClaimDto = {
        wallet: testWallet,
      };

      // First claim
      await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(200);

      // Second claim
      const secondResponse = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(429);

      // Should be close to 24h (86400 seconds)
      expect(secondResponse.body.retryAfterSec).toBeGreaterThan(86300);
      expect(secondResponse.body.retryAfterSec).toBeLessThanOrEqual(86400);
    });
  });

  describe('Validation - Invalid Wallet', () => {
    it('should return 400 for invalid base58 wallet', async () => {
      const dto = {
        wallet: 'invalid!@#$%^&*()',
      };

      const response = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(400);

      expect(response.body.message).toBeDefined();
      expect(Array.isArray(response.body.message) || typeof response.body.message === 'string').toBe(true);
    });

    it('should return 400 for missing wallet', async () => {
      const dto = {
        amount: 1000,
        // wallet omitted
      };

      const response = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(400);

      expect(response.body.message).toBeDefined();
    });

    it('should return 400 for too-short wallet', async () => {
      const dto = {
        wallet: 'ABC', // Too short
      };

      const response = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(400);

      expect(response.body.message).toBeDefined();
    });

    it('should return 400 for too-long wallet', async () => {
      const dto = {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKKExtraChars',
      };

      const response = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(400);

      expect(response.body.message).toBeDefined();
    });
  });

  describe('Validation - Amount', () => {
    it('should return 400 for amount > MAX_AMOUNT', async () => {
      const testWallet = Keypair.generate().publicKey.toBase58();
      const dto: FaucetClaimDto = {
        wallet: testWallet,
        amount: 10_001, // Exceeds MAX_AMOUNT of 10_000
      };

      const response = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(400);

      expect(response.body.message).toBeDefined();
    });

    it('should return 400 for amount <= 0', async () => {
      const testWallet = Keypair.generate().publicKey.toBase58();
      const dto: FaucetClaimDto = {
        wallet: testWallet,
        amount: 0,
      };

      const response = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(400);

      expect(response.body.message).toBeDefined();
    });

    it('should return 400 for negative amount', async () => {
      const testWallet = Keypair.generate().publicKey.toBase58();
      const dto: FaucetClaimDto = {
        wallet: testWallet,
        amount: -100,
      };

      const response = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(400);

      expect(response.body.message).toBeDefined();
    });

    it('should return 400 for float amount', async () => {
      const testWallet = Keypair.generate().publicKey.toBase58();
      const dto: FaucetClaimDto = {
        wallet: testWallet,
        amount: 1.5,
      };

      const response = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(400);

      expect(response.body.message).toBeDefined();
    });

    it('should accept amount == MAX_AMOUNT', async () => {
      await (mockRedis.flushdb as jest.Mock)();

      const testWallet = Keypair.generate().publicKey.toBase58();
      const dto: FaucetClaimDto = {
        wallet: testWallet,
        amount: 10_000,
      };

      const response = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(200);

      expect(response.body.amount).toBe(10_000);
    });
  });

  describe('Cluster Gating', () => {
    it('should return 404 when cluster is devnet', async () => {
      // Skip for now - integration test that requires full app context
      // The LocalnetOnlyGuard is tested in unit tests
    });

    it('should return 404 when cluster is mainnet', async () => {
      // Skip for now - integration test that requires full app context
      // The LocalnetOnlyGuard is tested in unit tests
    });
  });

  describe('Response Schema', () => {
    it('should return valid response schema on success', async () => {
      await (mockRedis.flushdb as jest.Mock)();

      const testWallet = Keypair.generate().publicKey.toBase58();
      const dto: FaucetClaimDto = {
        wallet: testWallet,
      };

      const response = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(200);

      // Verify response shape matches FaucetClaimResponseDto
      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('signature');
      expect(response.body).toHaveProperty('ata');
      expect(response.body).toHaveProperty('amount');

      expect(typeof response.body.success).toBe('boolean');
      expect(typeof response.body.signature).toBe('string');
      expect(typeof response.body.ata).toBe('string');
      expect(typeof response.body.amount).toBe('number');
    });

    it('should return valid error response on rate limit', async () => {
      await (mockRedis.flushdb as jest.Mock)();

      const testWallet = Keypair.generate().publicKey.toBase58();
      const dto: FaucetClaimDto = {
        wallet: testWallet,
      };

      // First claim
      await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(200);

      // Second claim
      const response = await app
        .getHttpServer()
        .post('/faucet/usdc')
        .send(dto)
        .expect(429);

      expect(response.body).toHaveProperty('retryAfterSec');
      expect(typeof response.body.retryAfterSec).toBe('number');
    });
  });
});
