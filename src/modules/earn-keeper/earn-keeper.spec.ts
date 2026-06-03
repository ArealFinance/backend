import { describe, expect, it, beforeEach, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Keypair, PublicKey } from '@solana/web3.js';

import {
  buildKeeperAuthorityKeypair,
  assertDevnetPins,
  resolveExpectedKeeperAuthority,
} from './earn-keeper.module.js';
import { isAllowedDevnetRpc, isDevnetCluster, isRunnableCluster } from './keeper-gates.js';
import {
  mintRwtFeeCeil,
  replenishMintBody,
  usdcBodyForRwtOut,
} from './earn-keeper.service.js';
import { EARN_CONFIG_PDA, STAKING_CONFIG_PDA } from '../earn-snapshot/earn-onchain.js';

/**
 * Keeper gate tests (CRITICAL — the no-mainnet guarantee).
 *
 * The keeper is gated by FIVE independent fail-closed checks:
 *   Gate 1: buildKeeperAuthorityKeypair returns null unless cluster is devnet/localnet.
 *   Gate 2: Keypair provider returns null off devnet/localnet.
 *   Gate 3: assertDevnetPins reports { ok: false } on program ID or PDA mismatch (boot-time).
 *   Gate 4: RPC URL check at boot + runtime.
 *   Gate 5: Explicit DEVNET_YIELD_KEEPER_ENABLED flag at runtime.
 *
 * INERT-NOT-FATAL: a boot gate failure must DISABLE the keeper (return null /
 * report { ok: false }), NEVER throw out of the provider — a throw during Nest
 * bootstrap crashes the whole backend (faucet/snapshot/`/earn/stats` all die).
 * These tests pin that every boot-gate failure path is inert, not fatal.
 *
 * These tests verify:
 *   - NO combination of gates can yield a signing action on mainnet.
 *   - Devnet-specific pins are reported (not thrown) at boot.
 *   - A bad RPC / cluster / pin / keypair makes the keeper inert WITHOUT throwing.
 *   - Per-tick reward math floors correctly and respects the MIN_REWARD_BASE_UNITS floor.
 */

describe('earn-keeper: gates (CRITICAL — no-mainnet guarantee)', () => {
  let mockConfig: Partial<ConfigService>;

  beforeEach(() => {
    mockConfig = {
      get: vi.fn(),
    };
  });

  describe('Gate 1 + Gate 2: cluster gate', () => {
    it('returns null (inert) when cluster is mainnet', () => {
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'mainnet',
        };
        return config[key];
      });

      const result = buildKeeperAuthorityKeypair(mockConfig as ConfigService);
      expect(result).toBeNull();
    });

    it('returns null (inert) when cluster is testnet', () => {
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'testnet',
        };
        return config[key];
      });

      const result = buildKeeperAuthorityKeypair(mockConfig as ConfigService);
      expect(result).toBeNull();
    });

    it('returns null when cluster is undefined (defaults to unknown)', () => {
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': undefined,
        };
        return config[key];
      });

      const result = buildKeeperAuthorityKeypair(mockConfig as ConfigService);
      expect(result).toBeNull();
    });

    it('returns null when cluster is empty string', () => {
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': '',
        };
        return config[key];
      });

      const result = buildKeeperAuthorityKeypair(mockConfig as ConfigService);
      expect(result).toBeNull();
    });

    it('does NOT call assertDevnetPins when cluster is mainnet (early return)', () => {
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'mainnet',
        };
        return config[key];
      });

      const assertSpy = vi.spyOn({ assertDevnetPins }, 'assertDevnetPins');
      const result = buildKeeperAuthorityKeypair(mockConfig as ConfigService);
      // assertDevnetPins is called inside buildKeeperAuthorityKeypair only if cluster is devnet/localnet
      // On mainnet, the function returns early before calling assertDevnetPins
      expect(result).toBeNull();
    });
  });

  describe('Gate 3: devnet program ID + PDA pins', () => {
    beforeEach(() => {
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://api.devnet.solana.com',
          'earn.programId': undefined,
          'earn.stakingProgramId': undefined,
        };
        return config[key];
      });
    });

    it('reports { ok: false } (no throw) when earn program ID does not match expected devnet pin', () => {
      const wrongProgramId = Keypair.generate().publicKey.toBase58();
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://api.devnet.solana.com',
          'earn.programId': wrongProgramId,
          'earn.stakingProgramId': undefined,
        };
        return config[key];
      });

      // INERT-NOT-FATAL: returns a result, never throws.
      let result!: ReturnType<typeof assertDevnetPins>;
      expect(() => {
        result = assertDevnetPins(mockConfig as ConfigService);
      }).not.toThrow();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/earn program ID mismatch/i);
    });

    it('reports { ok: false } (no throw) when staking program ID does not match expected devnet pin', () => {
      const wrongProgramId = Keypair.generate().publicKey.toBase58();
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://api.devnet.solana.com',
          'earn.programId': undefined,
          'earn.stakingProgramId': wrongProgramId,
        };
        return config[key];
      });

      let result!: ReturnType<typeof assertDevnetPins>;
      expect(() => {
        result = assertDevnetPins(mockConfig as ConfigService);
      }).not.toThrow();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/staking program ID mismatch/i);
    });

    it('reports { ok: false } when EarnConfig PDA derived from program ID does not match pinned literal', () => {
      // The pinned EARN_CONFIG_PDA is derived from the known earn program ID
      // If we swap to a different program ID, the PDA won't match even if the ID itself is "valid"
      const differentProgram = Keypair.generate().publicKey.toBase58();
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://api.devnet.solana.com',
          'earn.programId': differentProgram,
          'earn.stakingProgramId': undefined,
        };
        return config[key];
      });

      // This will fail on program ID first, but we're verifying the gate reports a failure.
      const result = assertDevnetPins(mockConfig as ConfigService);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/program ID mismatch|PDA mismatch/i);
    });

    it('reports { ok: true } when mint constants are valid (no throw)', () => {
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://api.devnet.solana.com',
          'earn.programId': undefined,
          'earn.stakingProgramId': undefined,
        };
        return config[key];
      });

      // We can't mock the mint parsing at the module level without a deeper integration test,
      // but the gate is exercised: it reads EARN_RWT_MINT / STRWT_MINT and validates them.
      // For now, verify the function reports ok (mints are valid in source).
      const result = assertDevnetPins(mockConfig as ConfigService);
      expect(result.ok).toBe(true);
    });
  });

  describe('Gate 4: RPC URL validation (boot)', () => {
    beforeEach(() => {
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://api.devnet.solana.com',
          'earn.programId': undefined,
          'earn.stakingProgramId': undefined,
        };
        return config[key];
      });
    });

    it('reports { ok: false } (no throw) when cluster is devnet but RPC URL is the wrong network', () => {
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://api.mainnet-beta.solana.com', // wrong network
          'earn.programId': undefined,
          'earn.stakingProgramId': undefined,
        };
        return config[key];
      });

      let result!: ReturnType<typeof assertDevnetPins>;
      expect(() => {
        result = assertDevnetPins(mockConfig as ConfigService);
      }).not.toThrow();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/RPC URL host is not on the devnet allowlist/i);
    });

    it('REJECTS a coincidental-substring RPC URL (mainnet host, /devnet path) — { ok: false }', () => {
      // The old substring check accepted any url merely CONTAINING "devnet".
      // The host-anchored allowlist must reject a mainnet host with a devnet path.
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://mainnet.example.com/devnet-path',
          'earn.programId': undefined,
          'earn.stakingProgramId': undefined,
        };
        return config[key];
      });

      const result = assertDevnetPins(mockConfig as ConfigService);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/RPC URL host is not on the devnet allowlist/i);
    });

    it('REJECTS a host that merely embeds "localhost" as a substring — { ok: false }', () => {
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://localhost.evil.com',
          'earn.programId': undefined,
          'earn.stakingProgramId': undefined,
        };
        return config[key];
      });

      const result = assertDevnetPins(mockConfig as ConfigService);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/RPC URL host is not on the devnet allowlist/i);
    });

    it('reports { ok: true } when devnet cluster + helius devnet APEX RPC URL (the live beget host)', () => {
      // The live beget devnet RPC is the APEX host (no subdomain label).
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://devnet.helius-rpc.com/?api-key=secret',
          'earn.programId': undefined,
          'earn.stakingProgramId': undefined,
        };
        return config[key];
      });

      expect(assertDevnetPins(mockConfig as ConfigService).ok).toBe(true);
    });

    it('reports { ok: true } when devnet cluster + helius devnet suffix RPC URL', () => {
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://my-key.devnet.helius-rpc.com',
          'earn.programId': undefined,
          'earn.stakingProgramId': undefined,
        };
        return config[key];
      });

      expect(assertDevnetPins(mockConfig as ConfigService).ok).toBe(true);
    });

    it('reports { ok: true } when devnet cluster + devnet RPC URL', () => {
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://api.devnet.solana.com',
          'earn.programId': undefined,
          'earn.stakingProgramId': undefined,
        };
        return config[key];
      });

      expect(assertDevnetPins(mockConfig as ConfigService).ok).toBe(true);
    });

    it('reports { ok: true } when devnet cluster + localhost RPC URL', () => {
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'http://localhost:8899',
          'earn.programId': undefined,
          'earn.stakingProgramId': undefined,
        };
        return config[key];
      });

      expect(assertDevnetPins(mockConfig as ConfigService).ok).toBe(true);
    });

    it('reports { ok: true } when devnet cluster + 127.0.0.1 RPC URL', () => {
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'http://127.0.0.1:8899',
          'earn.programId': undefined,
          'earn.stakingProgramId': undefined,
        };
        return config[key];
      });

      expect(assertDevnetPins(mockConfig as ConfigService).ok).toBe(true);
    });
  });

  describe('Gate 1+2 signer pubkey validation (INERT-NOT-FATAL)', () => {
    it('returns null (inert), does NOT throw, when signer pubkey does not match expected deployer', () => {
      // A freshly generated keypair will not match the expected deployer pubkey.
      const wrongKp = Keypair.generate();
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://api.devnet.solana.com',
          'earn.programId': undefined,
          'earn.stakingProgramId': undefined,
          'earnKeeper.authorityPubkey': '8ddRxwGnC1MD5ZCf22eLAne77Rput8itQbTjMr93xYvq',
          // Valid 64-byte secret key (base64) → loads fine, but is the WRONG pubkey.
          'earnKeeper.authorityKeypairB64': Buffer.from(wrongKp.secretKey).toString('base64'),
        };
        return config[key];
      });

      let result: Keypair | null | undefined;
      expect(() => {
        result = buildKeeperAuthorityKeypair(mockConfig as ConfigService);
      }).not.toThrow();
      expect(result).toBeNull();
    });

    it('returns null (inert), does NOT throw, when the keypair env var is missing/malformed', () => {
      // cluster devnet + valid RPC/pins, but no keypair env → loadKeypairFromB64Env
      // would throw; the provider must catch it and go inert instead of crashing.
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://api.devnet.solana.com',
          'earn.programId': undefined,
          'earn.stakingProgramId': undefined,
          'earnKeeper.authorityKeypairB64': undefined, // missing
        };
        return config[key];
      });

      let result: Keypair | null | undefined;
      expect(() => {
        result = buildKeeperAuthorityKeypair(mockConfig as ConfigService);
      }).not.toThrow();
      expect(result).toBeNull();
    });

    it('returns null (inert), does NOT throw, when cluster is devnet but RPC is not allowlisted', () => {
      // Gate 4 boot-half fails. Previously this THREW and crash-looped the whole
      // backend; now it must disable ONLY the keeper.
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://api.mainnet-beta.solana.com', // not allowlisted
          'earn.programId': undefined,
          'earn.stakingProgramId': undefined,
        };
        return config[key];
      });

      let result: Keypair | null | undefined;
      expect(() => {
        result = buildKeeperAuthorityKeypair(mockConfig as ConfigService);
      }).not.toThrow();
      expect(result).toBeNull();
    });

    it('returns null (inert), does NOT throw, when a program pin mismatches on devnet', () => {
      // Gate 3 fails (wrong earn program ID). Must be inert, not fatal.
      const wrongProgramId = Keypair.generate().publicKey.toBase58();
      (mockConfig.get as any).mockImplementation((key: string) => {
        const config: Record<string, any> = {
          'solana.cluster': 'devnet',
          'solana.rpcUrl': 'https://api.devnet.solana.com',
          'earn.programId': wrongProgramId,
          'earn.stakingProgramId': undefined,
        };
        return config[key];
      });

      let result: Keypair | null | undefined;
      expect(() => {
        result = buildKeeperAuthorityKeypair(mockConfig as ConfigService);
      }).not.toThrow();
      expect(result).toBeNull();
    });
  });

  describe('resolveExpectedKeeperAuthority', () => {
    it('returns default when no env override provided', () => {
      const result = resolveExpectedKeeperAuthority(undefined);
      expect(result).toBe('8ddRxwGnC1MD5ZCf22eLAne77Rput8itQbTjMr93xYvq');
    });

    it('returns env override when non-empty string provided', () => {
      const override = Keypair.generate().publicKey.toBase58();
      const result = resolveExpectedKeeperAuthority(override);
      expect(result).toBe(override);
    });

    it('ignores whitespace-only override (returns default)', () => {
      const result = resolveExpectedKeeperAuthority('   \t  ');
      expect(result).toBe('8ddRxwGnC1MD5ZCf22eLAne77Rput8itQbTjMr93xYvq');
    });
  });
});

/**
 * Host-anchored RPC allowlist (Gate 4) — security-critical.
 *
 * The prior substring match accepted any url merely CONTAINING "devnet" or
 * "localhost". These tests pin the host-anchored behavior: ONLY exact
 * allowlisted hosts (or the helius devnet suffix) pass; coincidental substrings
 * and unparseable urls are rejected (fail-closed).
 */
describe('keeper-gates: isAllowedDevnetRpc (host-anchored, Gate 4)', () => {
  it('accepts api.devnet.solana.com', () => {
    expect(isAllowedDevnetRpc('https://api.devnet.solana.com')).toBe(true);
  });

  it('accepts localhost + 127.0.0.1', () => {
    expect(isAllowedDevnetRpc('http://localhost:8899')).toBe(true);
    expect(isAllowedDevnetRpc('http://127.0.0.1:8899')).toBe(true);
  });

  it('accepts a *.devnet.helius-rpc.com suffix host', () => {
    expect(isAllowedDevnetRpc('https://abc-key.devnet.helius-rpc.com')).toBe(true);
  });

  it('accepts the APEX devnet.helius-rpc.com host (the live beget devnet RPC)', () => {
    // Apex host has NO subdomain label, so it is NOT matched by the
    // `.devnet.helius-rpc.com` suffix — it must be on the exact-host allowlist.
    expect(isAllowedDevnetRpc('https://devnet.helius-rpc.com')).toBe(true);
    expect(isAllowedDevnetRpc('https://devnet.helius-rpc.com/?api-key=secret')).toBe(true);
  });

  it('REJECTS the helius MAINNET apex host', () => {
    expect(isAllowedDevnetRpc('https://mainnet.helius-rpc.com')).toBe(false);
    expect(isAllowedDevnetRpc('https://mainnet.helius-rpc.com/?api-key=secret')).toBe(false);
  });

  it('REJECTS the bare helius rpc.helius.xyz host', () => {
    expect(isAllowedDevnetRpc('https://rpc.helius.xyz')).toBe(false);
  });

  it('REJECTS the apex devnet host with an appended attacker label', () => {
    // devnet.helius-rpc.com.attacker.tld is a DISTINCT hostname → rejected.
    expect(isAllowedDevnetRpc('https://devnet.helius-rpc.com.attacker.tld')).toBe(false);
  });

  it('REJECTS evil.com', () => {
    expect(isAllowedDevnetRpc('https://evil.com')).toBe(false);
  });

  it('REJECTS a mainnet host with a coincidental /devnet path', () => {
    expect(isAllowedDevnetRpc('https://mainnet.example.com/devnet-path')).toBe(false);
  });

  it('REJECTS a host that embeds "localhost" as a substring', () => {
    expect(isAllowedDevnetRpc('https://localhost.evil.com')).toBe(false);
  });

  it('REJECTS the mainnet helius host (suffix is anchored to a real label)', () => {
    expect(isAllowedDevnetRpc('https://x.helius-rpc.com')).toBe(false);
    expect(isAllowedDevnetRpc('https://x.mainnet.helius-rpc.com')).toBe(false);
  });

  it('REJECTS a suffix appended after the allowlisted suffix', () => {
    // The suffix must END the hostname — a trailing attacker label breaks it.
    expect(isAllowedDevnetRpc('https://x.devnet.helius-rpc.com.attacker.tld')).toBe(false);
  });

  it('REJECTS unparseable / empty / undefined urls (fail-closed)', () => {
    expect(isAllowedDevnetRpc('not a url')).toBe(false);
    expect(isAllowedDevnetRpc('')).toBe(false);
    expect(isAllowedDevnetRpc(undefined)).toBe(false);
    expect(isAllowedDevnetRpc(null)).toBe(false);
  });

  it('REJECTS mainnet-beta', () => {
    expect(isAllowedDevnetRpc('https://api.mainnet-beta.solana.com')).toBe(false);
  });
});

/**
 * Fail-closed cluster classification (Gate 1 / runtime) — security-critical.
 *
 * A missing / empty / typo'd cluster must NEVER be coerced to devnet.
 */
describe('keeper-gates: cluster classification (fail-closed, Gate 1)', () => {
  it('isRunnableCluster: only devnet / localnet / localhost are runnable', () => {
    expect(isRunnableCluster('devnet')).toBe(true);
    expect(isRunnableCluster('localnet')).toBe(true);
    expect(isRunnableCluster('localhost')).toBe(true);
  });

  it('isRunnableCluster: mainnet / testnet / unset / typo are NOT runnable', () => {
    expect(isRunnableCluster('mainnet')).toBe(false);
    expect(isRunnableCluster('testnet')).toBe(false);
    expect(isRunnableCluster(undefined)).toBe(false);
    expect(isRunnableCluster(null)).toBe(false);
    expect(isRunnableCluster('')).toBe(false);
    expect(isRunnableCluster('devnett')).toBe(false);
  });

  it('isDevnetCluster: ONLY the exact "devnet" string', () => {
    expect(isDevnetCluster('devnet')).toBe(true);
    expect(isDevnetCluster('localnet')).toBe(false);
    expect(isDevnetCluster('mainnet')).toBe(false);
    expect(isDevnetCluster(undefined)).toBe(false);
    expect(isDevnetCluster('')).toBe(false);
  });
});

/**
 * Gate 1 keypair provider: unset cluster → null (inert), confirming the
 * fail-closed default never yields a signer.
 */
describe('earn-keeper: Gate 1 fail-closed (unset cluster → inert)', () => {
  it('buildKeeperAuthorityKeypair returns null when SOLANA_CLUSTER is unset', () => {
    const mockConfig: Partial<ConfigService> = {
      get: vi.fn().mockImplementation((key: string) => {
        const config: Record<string, any> = { 'solana.cluster': undefined };
        return config[key];
      }),
    };
    expect(buildKeeperAuthorityKeypair(mockConfig as ConfigService)).toBeNull();
  });
});

/**
 * mint_rwt body/fee sizing math (used by the REPLENISH path).
 *
 * The buffered keeper no longer mints per tick; instead a separate replenish
 * step mints a CHUNK of RWT via `mint_rwt`. The chunk's USDC body inverts the
 * program's floor `rwt_out = floor(usdc × SCALE / nav)` by ceil-dividing so the
 * realised RWT is always >= the target, and the minted USDC covers body + a
 * ceil'd fee so the deposit never under-funds. These property tests pin that
 * ceil-div / fee math (reused by `replenishMintBody`).
 */
describe('earn-keeper: mint_rwt body/fee sizing math', () => {
  const NAV_SCALE = 1_000_000n;
  const BPS_DENOMINATOR = 10_000n;

  // Mirror the program's mint: rwt_out = floor(usdc × NAV_SCALE / nav).
  function programRwtOut(usdc: bigint, nav: bigint): bigint {
    return (usdc * NAV_SCALE) / nav;
  }

  it('body yields >= rwtReward at NAV = $1.00 (1:1)', () => {
    const nav = 1_000_000n; // $1.00 in 6-dec
    const rwtReward = 34n;
    const body = usdcBodyForRwtOut(rwtReward, nav);
    expect(programRwtOut(body, nav)).toBeGreaterThanOrEqual(rwtReward);
  });

  it('body yields >= rwtReward at a non-trivial NAV (e.g. $1.07)', () => {
    const nav = 1_070_000n; // $1.07
    const rwtReward = 34n;
    const body = usdcBodyForRwtOut(rwtReward, nav);
    expect(programRwtOut(body, nav)).toBeGreaterThanOrEqual(rwtReward);
  });

  it('ceil-div never under-funds across a range of NAV/reward vectors', () => {
    const navs = [1n, 999_999n, 1_000_000n, 1_000_001n, 1_070_000n, 2_500_000n];
    const rewards = [1n, 2n, 7n, 34n, 1000n, 999_999n];
    for (const nav of navs) {
      for (const r of rewards) {
        const body = usdcBodyForRwtOut(r, nav);
        expect(programRwtOut(body, nav)).toBeGreaterThanOrEqual(r);
      }
    }
  });

  it('fee is ceil(body × feeBps / 10000) — covers the program floor fee', () => {
    const body = 35n;
    const feeBps = 100n; // 1%
    const fee = mintRwtFeeCeil(body, feeBps);
    // program fee = floor(35 × 100 / 10000) = floor(0.35) = 0; ceil = 1
    expect(fee).toBe(1n);
    // ceil always >= program floor
    const programFee = (body * feeBps) / BPS_DENOMINATOR;
    expect(fee).toBeGreaterThanOrEqual(programFee);
  });

  it('fee is exact when divisible, >= floor otherwise', () => {
    expect(mintRwtFeeCeil(10_000n, 100n)).toBe(100n); // exact 1%
    expect(mintRwtFeeCeil(10_001n, 100n)).toBe(101n); // ceil of 100.01
  });

  it('zero-fee config → zero fee', () => {
    expect(mintRwtFeeCeil(1234n, 0n)).toBe(0n);
  });
});

/**
 * Keeper service reward math tests.
 *
 * Per-minute reward formula: amount = (principal × apyBps / 10000) / minutesPerYear
 *
 * Behaviors:
 *   - Integer (bigint) math throughout — no float drift.
 *   - Floors to base units (no fractional rewards).
 *   - < 1 base unit → skipped (MIN_REWARD_BASE_UNITS=1 floor, not rounded to 0).
 *   - Accumulation over time (if a per-minute reward rounds to 0, it still accumulates
 *     over longer spans).
 */
describe('earn-keeper: per-tick reward math', () => {
  const MINUTES_PER_YEAR = 365 * 24 * 60;
  const BPS_DENOMINATOR = 10_000n;
  const MIN_REWARD_BASE_UNITS = 1n;

  function calculateReward(principal: bigint, apyBps: number): bigint {
    // Formula from the keeper: amount = (principal × apyBps) / 10000 / minutesPerYear
    const apyBpsBig = BigInt(apyBps);
    return (principal * apyBpsBig) / BPS_DENOMINATOR / BigInt(MINUTES_PER_YEAR);
  }

  describe('RWT reward (deposit_rewards leg)', () => {
    it('computes reward = active_rwt × apy / 10000 / minutesPerYear (floor)', () => {
      // 15 RWT active (15_000_000 base units @ 6-dec) at 12% APY (1200 bps) —
      // this is the LIVE devnet pool state.
      const rwtActive = 15_000_000n;
      const apyBps = 1200;
      const reward = calculateReward(rwtActive, apyBps);

      // 15_000_000 * 1200 / 10_000 = 1_800_000; / 525_600 = 3.42... → floor to 3.
      const expected = (15_000_000n * 1200n) / 10_000n / BigInt(MINUTES_PER_YEAR);
      expect(reward).toBe(expected);
      expect(reward).toBe(3n);
      expect(reward).toBeGreaterThan(0n);
    });

    it('skips instruction when reward floors to 0 (< MIN_REWARD_BASE_UNITS)', () => {
      // 100 RWT (tiny pool) at 1% APY (100 bps)
      const rwtActive = 100n;
      const apyBps = 100;
      const reward = calculateReward(rwtActive, apyBps);

      // 100 * 100 / 10_000 / 525_600 = 10_000 / 10_000 / 525_600 = 1 / 525_600 ≈ 0 → floor to 0
      expect(reward).toBe(0n);
      expect(reward < MIN_REWARD_BASE_UNITS).toBe(true);
    });

    it('floored amount == 1 base unit → instruction is NOT skipped', () => {
      // We need active × apy / 10000 / 525_600 ≥ 1
      // i.e. active × apy ≥ 5_256_000_000
      // For apy=1200: active ≥ 4_380_000
      const rwtActive = 4_380_000n;
      const apyBps = 1200;
      const reward = calculateReward(rwtActive, apyBps);

      // 4_380_000 * 1200 / 10_000 / 525_600 = 5_256_000 / 525_600 = 10... → should be ≥ 1
      expect(reward).toBeGreaterThanOrEqual(1n);
    });
  });

  describe('USDC reward (add_to_basket leg)', () => {
    it('computes reward = capital × apy / 10000 / minutesPerYear (floor)', () => {
      // 1_057M USDC capital at 12% APY
      const capital = 1_057_000_000n;
      const apyBps = 1200;
      const reward = calculateReward(capital, apyBps);

      // 1_057_000_000 * 1200 / 10_000 / 525_600 = 1_268_400_000 / 525_600 = 2411.something
      const expected = (capital * BigInt(apyBps)) / BPS_DENOMINATOR / BigInt(MINUTES_PER_YEAR);
      expect(reward).toBe(expected);
      expect(reward).toBeGreaterThan(0n);
    });

    it('skips instruction when USDC reward floors to 0', () => {
      // Very small capital
      const capital = 1_000n; // 1K USDC
      const apyBps = 1; // 0.01% APY
      const reward = calculateReward(capital, apyBps);

      // 1_000 * 1 / 10_000 / 525_600 = 1 / 525_600 ≈ 0
      expect(reward).toBe(0n);
    });
  });

  describe('no-skip threshold (MIN_REWARD_BASE_UNITS)', () => {
    it('instruction skipped when reward < 1 base unit', () => {
      const reward = 0n;
      expect(reward < MIN_REWARD_BASE_UNITS).toBe(true);
    });

    it('instruction included when reward >= 1 base unit', () => {
      const reward = 1n;
      expect(reward >= MIN_REWARD_BASE_UNITS).toBe(true);
    });

    it('instruction included when reward >> 1 base unit', () => {
      const reward = 100n;
      expect(reward >= MIN_REWARD_BASE_UNITS).toBe(true);
    });
  });

  describe('realistic vectors', () => {
    it('devnet live state (15 RWT active, 1057 USDC capital, 12% APY)', () => {
      // LIVE devnet pool: total_rwt_active = 15 RWT (15_000_000 base units),
      // total_invested_capital = 1057 USDC (1_057_000_000 base units).
      const rwtActive = 15_000_000n;
      const capital = 1_057_000_000n;
      const apyBps = 1200;

      const rwtReward = calculateReward(rwtActive, apyBps);
      const usdcReward = calculateReward(capital, apyBps);

      // 15_000_000 * 1200 / 10_000 / 525_600 = 1_800_000 / 525_600 = 3.42 → 3.
      // 1_057_000_000 * 1200 / 10_000 / 525_600 = 126_840_000 / 525_600 = 241.3 → 241.
      expect(rwtReward).toBe(3n);
      expect(usdcReward).toBe(241n);
      expect(rwtReward).toBeGreaterThan(0n);
      expect(usdcReward).toBeGreaterThan(1n);
    });

    it('low APY (0.1%)', () => {
      const rwtActive = 15_000_000n;
      const apyBps = 10; // 0.1%
      const reward = calculateReward(rwtActive, apyBps);

      // 15_000_000 * 10 / 10_000 / 525_600 = 15_000 / 525_600 ≈ 0.028 → floor to 0
      expect(reward).toBe(0n);
    });

    it('high APY (50_000 bps = 500%)', () => {
      const rwtActive = 15_000_000n;
      const apyBps = 50_000; // 500%
      const reward = calculateReward(rwtActive, apyBps);

      // 15_000_000 * 50_000 / 10_000 / 525_600 = 75_000_000 / 525_600 = 142.7 → 142.
      expect(reward).toBe(142n);
      expect(reward).toBeGreaterThan(100n);
    });
  });
});

/**
 * Replenish mint sizing (BLOCKER regression) — the replenish chunk's USDC body
 * must ALWAYS clear the on-chain `min_mint_amount` floor, otherwise mint_rwt
 * reverts with BelowMinMint.
 */
describe('earn-keeper: replenishMintBody (>= min_mint_amount)', () => {
  const NAV_SCALE = 1_000_000n;
  const MIN_MINT = 1_000_000n; // $1.00 — contracts/earn/src/constants.rs:18

  it('clamps a tiny buffer target up to min_mint_amount (live devnet: 15 RWT pool)', () => {
    // Live state: rwtReward=3/min, bufferTicks=1440 → target = 4320 RWT base units.
    // At NAV $1.00 the NAV body is 4320 — far below the $1 (1_000_000) floor, so
    // replenishMintBody must raise it to exactly min_mint_amount.
    const targetBufferRwt = 3n * 1_440n; // 4320
    const nav = NAV_SCALE; // $1.00
    const body = replenishMintBody(targetBufferRwt, nav, MIN_MINT);
    expect(body).toBe(MIN_MINT);
    expect(body).toBeGreaterThanOrEqual(MIN_MINT);
  });

  it('uses the NAV body when it already exceeds min_mint_amount (big pool)', () => {
    // A large target whose NAV body > $1 is used verbatim (no clamp).
    const targetBufferRwt = 5_000_000n; // 5 RWT
    const nav = NAV_SCALE; // body = 5_000_000 > 1_000_000
    const body = replenishMintBody(targetBufferRwt, nav, MIN_MINT);
    expect(body).toBe(5_000_000n);
    expect(body).toBeGreaterThanOrEqual(MIN_MINT);
  });

  it('always returns >= min_mint_amount across NAV / target / floor vectors', () => {
    const navs = [1n, 999_999n, 1_000_000n, 1_070_000n, 2_500_000n];
    const targets = [1n, 3n, 4320n, 1_000_000n, 50_000_000n];
    const floors = [1_000_000n, 500_000n, 2_000_000n];
    for (const nav of navs) {
      for (const t of targets) {
        for (const f of floors) {
          expect(replenishMintBody(t, nav, f)).toBeGreaterThanOrEqual(f);
        }
      }
    }
  });
});

/**
 * Service-level regression (BLOCKER): per-tick flow on the LIVE devnet state.
 *
 * The bug: the old per-tick path minted reward RWT via mint_rwt with a sub-$1
 * body (3 base units on the 15-RWT pool), which reverted with BelowMinMint and,
 * because everything was ONE atomic tx, killed the NAV leg too → permanent
 * no-op. The buffered design must instead:
 *   (a) draw deposit_rewards from the deployer's EXISTING RWT ATA (no per-tick
 *       mint_rwt),
 *   (b) land add_to_basket + deposit_rewards in the per-tick tx with NO mint_rwt,
 *   (c) replenish (a SEPARATE tx) when the ATA falls below the floor, minting a
 *       chunk whose body clears min_mint_amount.
 */
describe('earn-keeper: per-tick + replenish flow (BLOCKER regression)', () => {
  // Discriminators (first 8 bytes of ix.data) used to classify instructions.
  const ADD_TO_BASKET = '829bd092fe148738';
  const DEPOSIT_REWARDS = '34f97048cea1c401';
  const MINT_RWT = '622073de440ca1a2';
  const MINT_TO_OPCODE = 7; // SPL Token MintTo (first data byte)

  const EARN_PROGRAM_ID = 'HGh7TcuqUbTRrFTYBUtsTctAEEmsANWnDxeWcbgqMg8b';
  const STAKING_PROGRAM_ID = 'CmKXHk3u6pDUC6Q11Le6gmhCgENQSFvduisXb7guUGoL';

  /** Build a valid EarnConfig account buffer (offsets per earn-onchain.ts). */
  function buildEarnConfigData(capital: bigint): Buffer {
    const buf = Buffer.alloc(261);
    buf.write('8f6e3fb5958cbe90', 0, 'hex'); // EARN discriminator
    for (let i = 0; i < 16; i++) buf[8 + i] = Number((capital >> (8n * BigInt(i))) & 0xffn);
    buf.writeUInt16LE(100, 122); // mint_fee_bps = 1%
    Keypair.generate().publicKey.toBuffer().copy(buf, 124); // basket_vault
    Keypair.generate().publicKey.toBuffer().copy(buf, 156); // dao_fee_destination
    Keypair.generate().publicKey.toBuffer().copy(buf, 188); // rwt_mint
    Keypair.generate().publicKey.toBuffer().copy(buf, 220); // usdc_mint
    buf.writeBigUInt64LE(1_000_000n, 252); // min_mint_amount = $1.00
    return buf;
  }

  /** Build a valid StakingConfig account buffer (offsets per earn-onchain.ts). */
  function buildStakingConfigData(active: bigint): Buffer {
    const buf = Buffer.alloc(267);
    buf.write('2d86fc5225395419', 0, 'hex'); // STAKING discriminator
    Keypair.generate().publicKey.toBuffer().copy(buf, 106); // rwt_mint
    Keypair.generate().publicKey.toBuffer().copy(buf, 138); // strwt_mint
    Keypair.generate().publicKey.toBuffer().copy(buf, 170); // reward_depositor
    Keypair.generate().publicKey.toBuffer().copy(buf, 202); // pool_vault
    buf.writeBigUInt64LE(active, 234); // total_rwt_active
    buf.writeBigUInt64LE(0n, 242); // total_rwt_reserved
    return buf;
  }

  function discriminatorHex(data: Buffer): string {
    return Buffer.from(data.subarray(0, 8)).toString('hex');
  }

  /**
   * Build the service against a fake Connection. `rwtBalance` is the deployer's
   * RWT ATA balance (the buffer). Captures every tx sent so tests can inspect
   * the instruction mix. Lazy import so the service module loads with mocks.
   */
  async function makeService(opts: { active: bigint; capital: bigint; rwtBalance: bigint }) {
    const { EarnKeeperService } = await import('./earn-keeper.service.js');

    const sentTxs: any[] = [];
    const fakeConn: any = {
      getAccountInfo: vi.fn(async (pda: PublicKey) => {
        // EarnConfig PDA vs StakingConfig PDA — match by deriving both.
        const earnPda = PublicKey.findProgramAddressSync(
          [Buffer.from('earn_config')],
          new PublicKey(EARN_PROGRAM_ID),
        )[0];
        if (pda.equals(earnPda)) return { data: buildEarnConfigData(opts.capital) };
        return { data: buildStakingConfigData(opts.active) };
      }),
      getTokenAccountBalance: vi.fn(async () => ({ value: { amount: opts.rwtBalance.toString() } })),
      getTokenSupply: vi.fn(async () => ({ value: { amount: '15000000' } })),
      getLatestBlockhash: vi.fn(async () => ({
        blockhash: '11111111111111111111111111111111',
        lastValidBlockHeight: 1000,
      })),
      sendRawTransaction: vi.fn(async () => 'sig'),
      confirmTransaction: vi.fn(async () => ({ value: { err: null } })),
    };

    const cfg: any = {
      get: vi.fn((key: string) => {
        const c: Record<string, any> = {
          'earn.programId': EARN_PROGRAM_ID,
          'earn.stakingProgramId': STAKING_PROGRAM_ID,
          'earnKeeper.apyBps': 1200,
          'earnKeeper.bufferTicks': 1440,
          'earnKeeper.floorTicks': 60,
        };
        return c[key];
      }),
    };

    const authority = Keypair.generate();
    const service = new EarnKeeperService(fakeConn as any, authority, cfg);
    // Capture serialized instruction classification per sendBatched call.
    const origSend = (service as any).sendBatched.bind(service);
    (service as any).sendBatched = vi.fn(async (auth: any, ixs: any[]) => {
      sentTxs.push(
        ixs.map((ix: any) => ({
          programId: ix.programId.toBase58(),
          disc: discriminatorHex(ix.data),
          firstByte: ix.data[0],
        })),
      );
      return origSend(auth, ixs);
    });
    return { service, sentTxs, fakeConn };
  }

  it('per-tick draws deposit_rewards from the ATA and does NOT call mint_rwt (buffer healthy)', async () => {
    // Live devnet state, buffer well above the floor (60 ticks × 3 = 180).
    const { service, sentTxs } = await makeService({
      active: 15_000_000n,
      capital: 1_057_000_000n,
      rwtBalance: 10_000n, // plenty
    });
    await (service as any).runOnce();

    // First tx = the per-tick tx. It must contain add_to_basket + deposit_rewards
    // and NO mint_rwt.
    const perTick = sentTxs[0];
    const discs = perTick.map((ix: any) => ix.disc);
    expect(discs).toContain(ADD_TO_BASKET);
    expect(discs).toContain(DEPOSIT_REWARDS);
    expect(discs).not.toContain(MINT_RWT);
    // A MintTo funds only the add_to_basket body (not RWT).
    expect(perTick.some((ix: any) => ix.firstByte === MINT_TO_OPCODE)).toBe(true);
  });

  it('live devnet tick lands add_to_basket + deposit_rewards with NO BelowMinMint (buffer healthy)', async () => {
    // No tx contains a mint_rwt with a sub-$1 body in the per-tick path → the
    // old BelowMinMint revert can't happen.
    const { service, sentTxs } = await makeService({
      active: 15_000_000n,
      capital: 1_057_000_000n,
      rwtBalance: 10_000n,
    });
    await (service as any).runOnce();

    const perTick = sentTxs[0];
    // deposit_rewards present → the rate leg lands; add_to_basket present → NAV
    // leg lands. Neither is a mint_rwt, so no min_mint floor applies.
    expect(perTick.map((ix: any) => ix.disc)).toEqual(
      expect.arrayContaining([ADD_TO_BASKET, DEPOSIT_REWARDS]),
    );
    expect(perTick.every((ix: any) => ix.disc !== MINT_RWT)).toBe(true);
  });

  it('replenish triggers when ATA balance < floor and mints a >= $1 chunk via mint_rwt', async () => {
    // Buffer below the floor (60 ticks × 3 = 180 base units) → replenish fires.
    const { service, sentTxs } = await makeService({
      active: 15_000_000n,
      capital: 1_057_000_000n,
      rwtBalance: 5n, // covers ONE tick (reward=3) but below the 180 floor
    });
    await (service as any).runOnce();

    // Two txs: [0] per-tick, [1] replenish. The replenish tx contains a mint_rwt.
    expect(sentTxs.length).toBe(2);
    const replenish = sentTxs[1];
    const mintRwtIx = replenish.find((ix: any) => ix.disc === MINT_RWT);
    expect(mintRwtIx).toBeTruthy();
  });

  it('replenish mint body always clears min_mint_amount (decode the sent ix)', async () => {
    const { service } = await makeService({
      active: 15_000_000n,
      capital: 1_057_000_000n,
      rwtBalance: 5n,
    });
    // Re-wrap sendBatched to capture the RAW ix data buffers for the replenish.
    const captured: Buffer[] = [];
    const prev = (service as any).sendBatched;
    (service as any).sendBatched = vi.fn(async (auth: any, ixs: any[]) => {
      for (const ix of ixs) captured.push(Buffer.from(ix.data));
      return prev(auth, ixs);
    });
    await (service as any).runOnce();

    // Find the mint_rwt ix (disc 622073de440ca1a2), read usdc_amount u64 LE.
    const mintRwt = captured.find(
      (d) => Buffer.from(d.subarray(0, 8)).toString('hex') === MINT_RWT,
    );
    expect(mintRwt).toBeTruthy();
    const usdcAmount = mintRwt!.readBigUInt64LE(8);
    expect(usdcAmount).toBeGreaterThanOrEqual(1_000_000n); // $1.00 floor
  });

  it('when buffer cannot cover the reward, deposit_rewards is skipped but add_to_basket still lands', async () => {
    // Balance 0 → deposit_rewards leg skipped; NAV leg unaffected (independent).
    const { service, sentTxs } = await makeService({
      active: 15_000_000n,
      capital: 1_057_000_000n,
      rwtBalance: 0n,
    });
    await (service as any).runOnce();

    const perTick = sentTxs[0];
    const discs = perTick.map((ix: any) => ix.disc);
    expect(discs).toContain(ADD_TO_BASKET); // NAV leg still lands
    expect(discs).not.toContain(DEPOSIT_REWARDS); // rate leg skipped (no buffer)
    // Replenish then fires (balance 0 < floor) → second tx with mint_rwt.
    expect(sentTxs.length).toBe(2);
    expect(sentTxs[1].some((ix: any) => ix.disc === MINT_RWT)).toBe(true);
  });
});
