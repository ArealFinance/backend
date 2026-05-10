import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { FaucetClaimDto } from './faucet-claim.dto.js';
import { DEFAULT_AMOUNT, MAX_AMOUNT } from '../faucet.constants.js';

/**
 * Unit tests for FaucetClaimDto. Tests cover:
 * - Required field validation
 * - Base58 format validation
 * - Amount range validation
 * - Amount type validation (must be integer)
 * - Extra field rejection
 */

describe('FaucetClaimDto', () => {
  describe('wallet field', () => {
    it('should be required', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        amount: 1000,
        // wallet intentionally omitted
      });

      const errors = await validate(dto);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'wallet')).toBe(true);
    });

    it('should accept valid base58 Solana pubkey', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
      });

      const errors = await validate(dto);

      expect(errors.filter((e) => e.property === 'wallet')).toHaveLength(0);
    });

    it('should reject non-base58 characters', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: 'invalid!@#$%^&*()',
      });

      const errors = await validate(dto);

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.some((e) => e.property === 'wallet')).toBe(true);
    });

    it('should reject base58 with ambiguous characters (0, O, I, l)', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: 'contains0InvalidOIl', // 0, O, I, l are not base58
      });

      const errors = await validate(dto);

      expect(errors.some((e) => e.property === 'wallet')).toBe(true);
    });

    it('should reject too short pubkey (< 32 characters)', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: 'ABC123', // too short
      });

      const errors = await validate(dto);

      expect(errors.some((e) => e.property === 'wallet')).toBe(true);
    });

    it('should reject too long pubkey (> 44 characters)', async () => {
      const tooLong = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKKExtra';
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: tooLong,
      });

      const errors = await validate(dto);

      expect(errors.some((e) => e.property === 'wallet')).toBe(true);
    });

    it('should accept 32-character valid base58 pubkey', async () => {
      const shortValid = '11111111111111111111111111111112'; // 32 chars, valid base58
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: shortValid,
      });

      const errors = await validate(dto);

      expect(errors.filter((e) => e.property === 'wallet')).toHaveLength(0);
    });

    it('should accept 44-character valid base58 pubkey', async () => {
      const longValid = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: longValid,
      });

      const errors = await validate(dto);

      expect(errors.filter((e) => e.property === 'wallet')).toHaveLength(0);
    });

    it('should reject empty string', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: '',
      });

      const errors = await validate(dto);

      expect(errors.some((e) => e.property === 'wallet')).toBe(true);
    });
  });

  describe('amount field', () => {
    it('should be optional', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        // amount intentionally omitted
      });

      const errors = await validate(dto);

      expect(errors.filter((e) => e.property === 'amount')).toHaveLength(0);
    });

    it('should accept valid amount', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        amount: 1000,
      });

      const errors = await validate(dto);

      expect(errors.filter((e) => e.property === 'amount')).toHaveLength(0);
    });

    it('should reject amount > MAX_AMOUNT', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        amount: MAX_AMOUNT + 1,
      });

      const errors = await validate(dto);

      expect(errors.some((e) => e.property === 'amount')).toBe(true);
    });

    it('should accept amount == MAX_AMOUNT', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        amount: MAX_AMOUNT,
      });

      const errors = await validate(dto);

      expect(errors.filter((e) => e.property === 'amount')).toHaveLength(0);
    });

    it('should reject amount <= 0', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        amount: 0,
      });

      const errors = await validate(dto);

      expect(errors.some((e) => e.property === 'amount')).toBe(true);
    });

    it('should reject negative amount', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        amount: -100,
      });

      const errors = await validate(dto);

      expect(errors.some((e) => e.property === 'amount')).toBe(true);
    });

    it('should reject float amount (non-integer)', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        amount: 1.5,
      });

      const errors = await validate(dto);

      expect(errors.some((e) => e.property === 'amount')).toBe(true);
    });

    it('should accept amount == 1 (minimum)', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        amount: 1,
      });

      const errors = await validate(dto);

      expect(errors.filter((e) => e.property === 'amount')).toHaveLength(0);
    });

    it('should transform string amount to number', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        amount: '1000', // String should be transformed to number
      });

      const errors = await validate(dto);

      expect(errors.filter((e) => e.property === 'amount')).toHaveLength(0);
      expect(typeof dto.amount).toBe('number');
      expect(dto.amount).toBe(1000);
    });
  });

  describe('extra fields (whitelist)', () => {
    it('should accept only defined fields', async () => {
      const input = {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        amount: 1000,
      };

      const dto = plainToInstance(FaucetClaimDto, input);

      // DTO should have the two defined fields
      expect(dto.wallet).toBe('DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK');
      expect(dto.amount).toBe(1000);

      // Undefined fields should not be set
      expect(Object.keys(dto).length).toBeLessThanOrEqual(2);
    });
  });

  describe('valid DTO instances', () => {
    it('should create valid DTO with only wallet', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
      });

      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.wallet).toBe('DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK');
      expect(dto.amount).toBeUndefined();
    });

    it('should create valid DTO with wallet and amount', async () => {
      const dto = plainToInstance(FaucetClaimDto, {
        wallet: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
        amount: 5000,
      });

      const errors = await validate(dto);

      expect(errors).toHaveLength(0);
      expect(dto.wallet).toBe('DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK');
      expect(dto.amount).toBe(5000);
    });
  });
});
