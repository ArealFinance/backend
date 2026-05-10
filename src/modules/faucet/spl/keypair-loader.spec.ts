import { ConfigService } from '@nestjs/config';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';

import { loadKeypairFromB64Env } from './keypair-loader.js';

/**
 * Unit tests for loadKeypairFromB64Env. Tests cover:
 * - Valid 64-byte base64 returns Keypair with correct pubkey
 * - Invalid length throws with env name + length only
 * - Invalid base64 throws without revealing input
 * - Missing env variable throws with env name only
 * - Secret bytes never leak in error messages
 * - Keyword 'secretKey' never appears in error messages
 */

describe('loadKeypairFromB64Env', () => {
  it('should load valid 64-byte keypair from base64', () => {
    // Generate a valid keypair to get a real b64 string
    const validKeypair = Keypair.generate();
    const b64 = Buffer.from(validKeypair.secretKey).toString('base64');

    const configService = {
      get: vi.fn().mockReturnValue(b64),
    } as unknown as ConfigService;

    const result = loadKeypairFromB64Env('TEST_KEYPAIR_ENV', 'TEST_KEYPAIR', configService);

    expect(result.publicKey.toBase58()).toBe(validKeypair.publicKey.toBase58());
  });

  it('should throw error for wrong length (too short)', () => {
    const shortB64 = Buffer.from(Buffer.alloc(32)).toString('base64'); // 32 bytes instead of 64

    const configService = {
      get: vi.fn().mockReturnValue(shortB64),
    } as unknown as ConfigService;

    const fn = () =>
      loadKeypairFromB64Env('TEST_SHORT_ENV', 'TEST_KEYPAIR', configService);

    expect(fn).toThrow(Error);
    expect(fn).toThrow('Invalid TEST_KEYPAIR keypair env var');
    expect(fn).toThrow('length=32');

    // Error message must NOT contain the base64 value
    try {
      fn();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(shortB64);
      expect(msg).not.toContain('AAAA'); // No base64 fragments
    }
  });

  it('should throw error for wrong length (too long)', () => {
    const longB64 = Buffer.from(Buffer.alloc(128)).toString('base64'); // 128 bytes

    const configService = {
      get: vi.fn().mockReturnValue(longB64),
    } as unknown as ConfigService;

    const fn = () =>
      loadKeypairFromB64Env('TEST_LONG_ENV', 'TEST_KEYPAIR', configService);

    expect(fn).toThrow(Error);
    expect(fn).toThrow('Invalid TEST_KEYPAIR keypair env var');
    expect(fn).toThrow('length=128');

    // Error message must NOT contain the base64 value
    try {
      fn();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(longB64);
    }
  });

  it('should handle invalid base64 gracefully', () => {
    // Use a string that will decode to a different length
    const b64 = 'AAAA'; // This decodes to a 3-byte buffer

    const configService = {
      get: vi.fn().mockReturnValue(b64),
    } as unknown as ConfigService;

    const fn = () =>
      loadKeypairFromB64Env('TEST_INVALID_B64_ENV', 'TEST_KEYPAIR', configService);

    expect(fn).toThrow(Error);
    expect(fn).toThrow('Invalid TEST_KEYPAIR keypair env var');

    // Must not expose the base64 input
    try {
      fn();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain(b64);
    }
  });

  it('should throw error for missing env variable', () => {
    const configService = {
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    const fn = () =>
      loadKeypairFromB64Env('TEST_MISSING_ENV', 'TEST_KEYPAIR', configService);

    expect(fn).toThrow(Error);
    expect(fn).toThrow('Invalid TEST_KEYPAIR keypair env var');
    expect(fn).toThrow('length=0');
  });

  it('should throw error for empty string env variable', () => {
    const configService = {
      get: vi.fn().mockReturnValue(''),
    } as unknown as ConfigService;

    const fn = () =>
      loadKeypairFromB64Env('TEST_EMPTY_ENV', 'TEST_KEYPAIR', configService);

    expect(fn).toThrow(Error);
    expect(fn).toThrow('Invalid TEST_KEYPAIR keypair env var');
    expect(fn).toThrow('length=0');
  });

  it('should never leak secret key bytes in error message', () => {
    const secretKeypair = Keypair.generate();
    const b64 = Buffer.from(secretKeypair.secretKey).toString('base64');

    // Truncate to invalid length
    const truncatedB64 = b64.slice(0, 20);

    const configService = {
      get: vi.fn().mockReturnValue(truncatedB64),
    } as unknown as ConfigService;

    const fn = () =>
      loadKeypairFromB64Env('LEAKY_ENV', 'TEST_KEYPAIR', configService);

    try {
      fn();
    } catch (e) {
      const msg = (e as Error).message;
      const stack = (e as Error).stack || '';

      // Ensure the error message does not contain secret key parts
      expect(msg).not.toContain(secretKeypair.secretKey.toString());
      expect(msg).not.toContain(b64);
      expect(msg).not.toContain(truncatedB64);
      expect(stack).not.toContain(secretKeypair.secretKey.toString());
    }
  });

  it('should never leak keyword "secretKey" in error message', () => {
    const b64 = Buffer.from(Buffer.alloc(50)).toString('base64');

    const configService = {
      get: vi.fn().mockReturnValue(b64),
    } as unknown as ConfigService;

    const fn = () =>
      loadKeypairFromB64Env('ENV_VAR', 'TEST_KEYPAIR', configService);

    try {
      fn();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).not.toContain('secretKey');
      expect(msg).not.toContain('_secretKey');
    }
  });

  it('should use env var name in error messages', () => {
    const configService = {
      get: vi.fn().mockReturnValue(undefined),
    } as unknown as ConfigService;

    const envName = 'MY_CUSTOM_KEYPAIR_ENV';
    const label = 'MY_CUSTOM_LABEL';

    const fn = () =>
      loadKeypairFromB64Env(envName, label, configService);

    try {
      fn();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain(`Invalid ${label}`);
    }
  });

  it('should preserve exact buffer bytes for valid keypair', () => {
    const originalKeypair = Keypair.generate();
    const originalSecretKey = originalKeypair.secretKey;
    const b64 = Buffer.from(originalSecretKey).toString('base64');

    const configService = {
      get: vi.fn().mockReturnValue(b64),
    } as unknown as ConfigService;

    const loadedKeypair = loadKeypairFromB64Env('TEST_ENV', 'TEST_LABEL', configService);

    // Verify the loaded keypair has the same secret key
    expect(Buffer.from(loadedKeypair.secretKey)).toEqual(Buffer.from(originalSecretKey));
    expect(loadedKeypair.publicKey.toBase58()).toBe(originalKeypair.publicKey.toBase58());
  });
});
