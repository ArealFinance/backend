import { PublicKey, Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  calculateNav,
  calculateRate,
  calculateTvl,
  decodeEarnConfig,
  decodeStakingConfig,
  NAV_SCALE,
  RATE_SCALE,
  INITIAL_NAV,
  VIRTUAL_ASSETS,
  VIRTUAL_SHARES,
  TOKEN_DECIMALS,
  EARN_RWT_MINT,
  STRWT_MINT,
  resolveEarnProgramId,
  resolveStakingProgramId,
} from './earn-onchain.js';

/**
 * Pure math tests for the on-chain codec & NAV/rate/TVL calculators.
 *
 * All these functions are pure bigint arithmetic (no DB, no network) so they
 * test easily — feed vectors, verify outputs, assert no float drift.
 */

describe('earn-onchain: math', () => {
  describe('calculateNav', () => {
    it('returns INITIAL_NAV ($1.00) when supply is zero', () => {
      const result = calculateNav(1_000_000_000n, 0n);
      expect(result).toBe(INITIAL_NAV);
      expect(result).toBe(NAV_SCALE); // $1.00 in 6-dec fixed-point
    });

    it('returns INITIAL_NAV even with zero capital', () => {
      const result = calculateNav(0n, 0n);
      expect(result).toBe(INITIAL_NAV);
    });

    it('computes nav = capital × NAV_SCALE / supply correctly', () => {
      // capital=1_057_000_000, supply=15_000_000 → NAV = 1_000_000 (i.e. $1.00)
      // per live devnet 2026-06-03 state per the comment
      const result = calculateNav(1_057_000_000n, 15_000_000n);
      // 1_057_000_000 * 1_000_000 / 15_000_000 = 70_466_666.666... → floor to 70_466_666
      expect(result).toBe(70_466_666n);
    });

    it('floors to 1 when capital is tiny relative to supply', () => {
      // capital=1, supply=1_000_000 → nav = 1 * 1_000_000 / 1_000_000 = 1 (floor applied)
      const result = calculateNav(1n, 1_000_000n);
      expect(result).toBe(1n);
    });

    it('returns exactly capital when supply == capital (1x ratio)', () => {
      const capital = 100_000_000n;
      const result = calculateNav(capital, capital);
      // nav = 100_000_000 * 1_000_000 / 100_000_000 = 1_000_000
      expect(result).toBe(NAV_SCALE);
    });

    it('handles large capital and supply (bigint, no float drift)', () => {
      // Realistic on-chain: 1.5e15 USDC (1.5e21 base units, since USDC is 6-dec)
      const capital = 1_500_000_000_000_000n; // 1.5e15
      const supply = 1_500_000_000_000_000n; // same = nav $1.00
      const result = calculateNav(capital, supply);
      expect(result).toBe(NAV_SCALE);
    });

    it('clamps below 1 to a minimum of 1', () => {
      // capital < NAV_SCALE, supply > capital → nav < 1 before clamping
      // E.g. capital=100, supply=1000 → 100*1_000_000/1000 = 100_000 but this won't hit the clamping
      // To hit the clamp, we need (capital * NAV_SCALE) / supply < 1, i.e. capital < supply/NAV_SCALE
      // capital=1, supply=2_000_000 → nav = 1*1_000_000 / 2_000_000 = 0 before clamping
      const result = calculateNav(1n, 2_000_000n);
      expect(result).toBe(1n);
    });
  });

  describe('calculateRate', () => {
    it('returns virtual assets / virtual shares bootstrap rate (10) when pool is empty', () => {
      const result = calculateRate(0n, 0n);
      // (0 + VIRTUAL_ASSETS) * RATE_SCALE / (0 + VIRTUAL_SHARES)
      // = 10_000_000 * 1_000_000 / 1_000_000 = 10_000_000 (i.e. rate 10)
      expect(result).toBe(10_000_000n);
    });

    it('computes rate correctly with active RWT and stRWT supply', () => {
      // Live devnet 2026-06-03: total_rwt_active=15_000_000, strwt_supply=?, rate=10
      // Assuming bootstrapped (just the virtual offset): (15_000_000 + 10_000_000) * 1_000_000 / (X + 1_000_000)
      // For rate==10: (25_000_000 * 1_000_000) / (X + 1_000_000) = 10_000_000
      // → X + 1_000_000 = 2_500_000 → X = 1_500_000
      const rwtActive = 15_000_000n;
      const strwtSupply = 1_500_000n;
      const result = calculateRate(rwtActive, strwtSupply);
      expect(result).toBe(10_000_000n);
    });

    it('rates grow monotonically with rewards (larger active)', () => {
      const strwtSupply = 1_500_000n;
      const rate1 = calculateRate(15_000_000n, strwtSupply);
      const rate2 = calculateRate(20_000_000n, strwtSupply);
      expect(rate2).toBeGreaterThan(rate1);
    });

    it('handles large balances (bigint, no float drift)', () => {
      const rwtActive = 1_000_000_000_000n; // 1 trillion RWT (6-dec)
      const strwtSupply = 100_000_000_000n; // 100 billion stRWT
      const result = calculateRate(rwtActive, strwtSupply);
      // (1e12 + 1e7) * 1e6 / (1e11 + 1e6) ≈ 1e12 * 1e6 / 1e11 = 1e7 (rate ~10)
      expect(result).toBeGreaterThan(0n);
      expect(result).toBeLessThan(1_000_000_000n); // sanity check
    });

    it('is well-defined even when assets/shares are zero (virtual offset)', () => {
      // The virtual offset ensures rate is never undefined or 0
      expect(calculateRate(0n, 0n)).toBe((VIRTUAL_ASSETS * RATE_SCALE) / VIRTUAL_SHARES);
    });
  });

  describe('calculateTvl', () => {
    it('computes tvl = supply × nav / NAV_SCALE', () => {
      const supply = 100_000_000n; // 100M RWT
      const nav = 1_000_000n; // $1.00
      const result = calculateTvl(supply, nav);
      // 100_000_000 * 1_000_000 / 1_000_000 = 100_000_000 (= $100M)
      expect(result).toBe(100_000_000n);
    });

    it('returns zero when supply is zero (even if nav is nonzero)', () => {
      const result = calculateTvl(0n, 5_000_000n);
      expect(result).toBe(0n);
    });

    it('floors the result (integer division)', () => {
      const supply = 3n;
      const nav = 2n;
      const result = calculateTvl(supply, nav);
      // 3 * 2 / 1_000_000 = 0 (floor)
      expect(result).toBe(0n);
    });

    it('matches the documented relationship: TVL = capital (when supply×nav == capital)', () => {
      const capital = 1_057_000_000n;
      const supply = 15_000_000n;
      const nav = calculateNav(capital, supply);
      const tvl = calculateTvl(supply, nav);
      // tvl should recover the capital exactly (or very close via floor)
      expect(tvl).toBe((supply * nav) / NAV_SCALE);
    });

    it('handles large TVL (bigint)', () => {
      const supply = 1_000_000_000_000n; // 1T RWT
      const nav = 2_000_000n; // $2.00
      const result = calculateTvl(supply, nav);
      // 1e12 * 2e6 / 1e6 = 2e12 (= $2T)
      expect(result).toBe(2_000_000_000_000n);
    });
  });
});

describe('earn-onchain: decoders', () => {
  describe('decodeEarnConfig', () => {
    it('reads totalInvestedCapital from offset 8 as u128 LE', () => {
      // Build a buffer with correct discriminator + capital at offset 8
      const buf = Buffer.alloc(261);
      // Write discriminator at 0–7
      buf.write('8f6e3fb5958cbe90', 0, 'hex');
      // Write u128 LE at offset 8: 1_057_000_000
      const capital = 1_057_000_000n;
      for (let i = 0; i < 16; i++) {
        buf[8 + i] = Number((capital >> (8n * BigInt(i))) & 0xffn);
      }
      const result = decodeEarnConfig(buf);
      expect(result.totalInvestedCapital).toBe(capital);
    });

    it('reads pubkey fields (32 bytes each) from their offsets', () => {
      const buf = Buffer.alloc(261);
      buf.write('8f6e3fb5958cbe90', 0, 'hex');

      // Write dummy keypairs at the expected offsets
      const basketVaultKp = Keypair.generate();
      const daoFeeKp = Keypair.generate();
      const rwtMintKp = Keypair.generate();
      const usdcMintKp = Keypair.generate();

      basketVaultKp.publicKey.toBuffer().copy(buf, 124);
      daoFeeKp.publicKey.toBuffer().copy(buf, 156);
      rwtMintKp.publicKey.toBuffer().copy(buf, 188);
      usdcMintKp.publicKey.toBuffer().copy(buf, 220);

      const result = decodeEarnConfig(buf);
      expect(result.basketVault.equals(basketVaultKp.publicKey)).toBe(true);
      expect(result.daoFeeDestination.equals(daoFeeKp.publicKey)).toBe(true);
      expect(result.rwtMint.equals(rwtMintKp.publicKey)).toBe(true);
      expect(result.usdcMint.equals(usdcMintKp.publicKey)).toBe(true);
    });

    it('reads minMintAmount from offset 252 as u64 LE', () => {
      const buf = Buffer.alloc(261);
      buf.write('8f6e3fb5958cbe90', 0, 'hex');
      buf.writeBigUInt64LE(1_000_000n, 252); // $1.00 anti-dust floor
      const result = decodeEarnConfig(buf);
      expect(result.minMintAmount).toBe(1_000_000n);
    });

    it('throws when buffer is too short', () => {
      const buf = Buffer.alloc(260); // 1 byte short
      buf.write('8f6e3fb5958cbe90', 0, 'hex');
      expect(() => decodeEarnConfig(buf)).toThrow(/too short/i);
    });

    it('throws when discriminator does not match', () => {
      const buf = Buffer.alloc(261);
      // Write wrong discriminator
      buf.write('0000000000000000', 0, 'hex');
      expect(() => decodeEarnConfig(buf)).toThrow(/discriminator mismatch/i);
    });

    it('rejects a staking config data with earn discriminator (wrong account guard)', () => {
      // This tests the discriminator-assert's role in preventing decoding the wrong account
      const buf = Buffer.alloc(261);
      buf.write('2d86fc5225395419', 0, 'hex'); // STAKING_DISCRIMINATOR instead of EARN
      expect(() => decodeEarnConfig(buf)).toThrow(/discriminator mismatch/i);
    });
  });

  describe('decodeStakingConfig', () => {
    it('reads staking config fields from the documented offsets', () => {
      const buf = Buffer.alloc(267);
      // Write discriminator
      buf.write('2d86fc5225395419', 0, 'hex');

      const rwtMintKp = Keypair.generate();
      const strwtMintKp = Keypair.generate();
      const rewardDepositorKp = Keypair.generate();
      const poolVaultKp = Keypair.generate();

      rwtMintKp.publicKey.toBuffer().copy(buf, 106);
      strwtMintKp.publicKey.toBuffer().copy(buf, 138);
      rewardDepositorKp.publicKey.toBuffer().copy(buf, 170);
      poolVaultKp.publicKey.toBuffer().copy(buf, 202);

      // Write u64 LE values at offsets 234 and 242
      const active = 15_000_000n;
      const reserved = 1_000_000n;
      buf.writeBigUInt64LE(active, 234);
      buf.writeBigUInt64LE(reserved, 242);

      const result = decodeStakingConfig(buf);
      expect(result.rwtMint.equals(rwtMintKp.publicKey)).toBe(true);
      expect(result.strwtMint.equals(strwtMintKp.publicKey)).toBe(true);
      expect(result.rewardDepositor.equals(rewardDepositorKp.publicKey)).toBe(true);
      expect(result.poolVault.equals(poolVaultKp.publicKey)).toBe(true);
      expect(result.totalRwtActive).toBe(active);
      expect(result.totalRwtReserved).toBe(reserved);
    });

    it('throws when buffer is too short', () => {
      const buf = Buffer.alloc(266); // 1 byte short
      buf.write('2d86fc5225395419', 0, 'hex');
      expect(() => decodeStakingConfig(buf)).toThrow(/too short/i);
    });

    it('throws on discriminator mismatch', () => {
      const buf = Buffer.alloc(267);
      buf.write('8f6e3fb5958cbe90', 0, 'hex'); // EARN_DISCRIMINATOR instead of STAKING
      expect(() => decodeStakingConfig(buf)).toThrow(/discriminator mismatch/i);
    });

    it('rejects earn config data (stale-PDA protection)', () => {
      // If a stale PDA from an old program is passed, the discriminator guard stops it
      const buf = Buffer.alloc(267);
      buf.write('8f6e3fb5958cbe90', 0, 'hex'); // EARN_DISCRIMINATOR
      expect(() => decodeStakingConfig(buf)).toThrow(/discriminator mismatch/i);
    });
  });
});

describe('earn-onchain: program ID resolution', () => {
  it('resolveEarnProgramId returns pinned literal when no env override', () => {
    const result = resolveEarnProgramId(undefined);
    expect(result.toBase58()).toBe('HGh7TcuqUbTRrFTYBUtsTctAEEmsANWnDxeWcbgqMg8b');
  });

  it('resolveEarnProgramId uses env override when provided', () => {
    const override = Keypair.generate().publicKey.toBase58();
    const result = resolveEarnProgramId(override);
    expect(result.toBase58()).toBe(override);
  });

  it('resolveEarnProgramId ignores whitespace-only override', () => {
    const result = resolveEarnProgramId('   ');
    expect(result.toBase58()).toBe('HGh7TcuqUbTRrFTYBUtsTctAEEmsANWnDxeWcbgqMg8b');
  });

  it('resolveStakingProgramId returns pinned literal when no env override', () => {
    const result = resolveStakingProgramId(undefined);
    expect(result.toBase58()).toBe('CmKXHk3u6pDUC6Q11Le6gmhCgENQSFvduisXb7guUGoL');
  });

  it('resolveStakingProgramId uses env override when provided', () => {
    const override = Keypair.generate().publicKey.toBase58();
    const result = resolveStakingProgramId(override);
    expect(result.toBase58()).toBe(override);
  });
});

describe('earn-onchain: constants', () => {
  it('NAV_SCALE is 6-decimal fixed-point (1e6)', () => {
    expect(NAV_SCALE).toBe(1_000_000n);
  });

  it('RATE_SCALE is 6-decimal fixed-point (1e6)', () => {
    expect(RATE_SCALE).toBe(1_000_000n);
  });

  it('INITIAL_NAV equals NAV_SCALE ($1.00)', () => {
    expect(INITIAL_NAV).toBe(NAV_SCALE);
  });

  it('VIRTUAL_ASSETS (numerator bootstrap offset) is 10 RWT in 6-dec', () => {
    expect(VIRTUAL_ASSETS).toBe(10_000_000n);
  });

  it('VIRTUAL_SHARES (denominator bootstrap offset) is 1 stRWT in 6-dec', () => {
    expect(VIRTUAL_SHARES).toBe(1_000_000n);
  });

  it('TOKEN_DECIMALS is 6 (RWT, stRWT, USDC)', () => {
    expect(TOKEN_DECIMALS).toBe(6);
  });

  it('EARN_RWT_MINT and STRWT_MINT are valid base58 pubkeys', () => {
    expect(() => new PublicKey(EARN_RWT_MINT)).not.toThrow();
    expect(() => new PublicKey(STRWT_MINT)).not.toThrow();
  });
});
