import { ConfigService } from '@nestjs/config';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { buildFaucetAuthorityKeypair, buildRwtTreasuryKeypair } from './faucet.module.js';
import { DEFAULT_EXPECTED_AUTHORITY, DEFAULT_EXPECTED_RWT_TREASURY } from './faucet.constants.js';

/**
 * Boot-time safety pin for the faucet USDC authority.
 *
 * After a test-validator reset the deployer (= faucet authority) rotates.
 * The expected pubkey is sourced from the `FAUCET_USDC_AUTHORITY` env
 * (`faucet.usdcAuthorityPubkey` in config) so the check tracks the live
 * deployer without a code change; it falls back to
 * `DEFAULT_EXPECTED_AUTHORITY` when the env is unset.
 *
 * These tests exercise `buildFaucetAuthorityKeypair` directly with a stub
 * `ConfigService` — no Nest test bed, so no real Redis/RPC connections.
 */

/** Minimal ConfigService stub backed by a plain key→value map. */
function stubConfig(values: Record<string, unknown>): ConfigService {
  return {
    get: <T>(key: string): T | undefined => values[key] as T | undefined,
  } as unknown as ConfigService;
}

/** Base64-encode a keypair's 64-byte secret the way the env var carries it. */
function kpToB64(kp: Keypair): string {
  return Buffer.from(kp.secretKey).toString('base64');
}

describe('buildFaucetAuthorityKeypair (boot-time authority pin)', () => {
  it('returns null on a non-localnet cluster (faucet disabled)', () => {
    const kp = Keypair.generate();
    const config = stubConfig({
      'solana.cluster': 'mainnet',
      FAUCET_USDC_AUTHORITY_KEYPAIR_B64: kpToB64(kp),
    });
    expect(buildFaucetAuthorityKeypair(config)).toBeNull();
  });

  it('loads the keypair when it matches the env-supplied expected pubkey', () => {
    const kp = Keypair.generate();
    const config = stubConfig({
      'solana.cluster': 'localnet',
      'faucet.usdcAuthorityPubkey': kp.publicKey.toBase58(),
      FAUCET_USDC_AUTHORITY_KEYPAIR_B64: kpToB64(kp),
    });
    const loaded = buildFaucetAuthorityKeypair(config);
    expect(loaded).not.toBeNull();
    expect(loaded!.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('refuses to boot when the keypair does NOT match the env-supplied pubkey', () => {
    const wrongKp = Keypair.generate();
    const expectedPubkey = Keypair.generate().publicKey.toBase58();
    const config = stubConfig({
      'solana.cluster': 'localnet',
      'faucet.usdcAuthorityPubkey': expectedPubkey,
      FAUCET_USDC_AUTHORITY_KEYPAIR_B64: kpToB64(wrongKp),
    });
    expect(() => buildFaucetAuthorityKeypair(config)).toThrow(/pubkey mismatch/i);
    expect(() => buildFaucetAuthorityKeypair(config)).toThrow(
      new RegExp(`expected ${expectedPubkey}`),
    );
  });

  it('falls back to DEFAULT_EXPECTED_AUTHORITY when the env pubkey is unset', () => {
    // No matching keypair for the default deployer pubkey is available in a
    // unit test, so the fallback path must reject a random keypair — proving
    // the default pin is in force, not silently bypassed.
    const randomKp = Keypair.generate();
    const config = stubConfig({
      'solana.cluster': 'localnet',
      // faucet.usdcAuthorityPubkey intentionally absent
      FAUCET_USDC_AUTHORITY_KEYPAIR_B64: kpToB64(randomKp),
    });
    expect(() => buildFaucetAuthorityKeypair(config)).toThrow(
      new RegExp(`expected ${DEFAULT_EXPECTED_AUTHORITY}`),
    );
  });

  it('blank/whitespace env pubkey falls back to the default (no empty-string pin)', () => {
    const randomKp = Keypair.generate();
    const config = stubConfig({
      'solana.cluster': 'localnet',
      'faucet.usdcAuthorityPubkey': '   ',
      FAUCET_USDC_AUTHORITY_KEYPAIR_B64: kpToB64(randomKp),
    });
    expect(() => buildFaucetAuthorityKeypair(config)).toThrow(
      new RegExp(`expected ${DEFAULT_EXPECTED_AUTHORITY}`),
    );
  });
});

describe('buildRwtTreasuryKeypair (boot-time RWT treasury pin)', () => {
  it('returns null on mainnet (RWT faucet disabled)', () => {
    const kp = Keypair.generate();
    const config = stubConfig({
      'solana.cluster': 'mainnet',
      FAUCET_RWT_TREASURY_KEYPAIR_B64: kpToB64(kp),
    });
    expect(buildRwtTreasuryKeypair(config)).toBeNull();
  });

  it('loads the keypair on devnet when it matches the env-supplied expected pubkey', () => {
    const kp = Keypair.generate();
    const config = stubConfig({
      'solana.cluster': 'devnet',
      'faucet.rwtTreasuryPubkey': kp.publicKey.toBase58(),
      FAUCET_RWT_TREASURY_KEYPAIR_B64: kpToB64(kp),
    });
    const loaded = buildRwtTreasuryKeypair(config);
    expect(loaded).not.toBeNull();
    expect(loaded!.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('loads the keypair on localnet when it matches the env-supplied expected pubkey', () => {
    const kp = Keypair.generate();
    const config = stubConfig({
      'solana.cluster': 'localnet',
      'faucet.rwtTreasuryPubkey': kp.publicKey.toBase58(),
      FAUCET_RWT_TREASURY_KEYPAIR_B64: kpToB64(kp),
    });
    const loaded = buildRwtTreasuryKeypair(config);
    expect(loaded).not.toBeNull();
    expect(loaded!.publicKey.toBase58()).toBe(kp.publicKey.toBase58());
  });

  it('refuses to boot when the keypair does NOT match the env-supplied pubkey', () => {
    const wrongKp = Keypair.generate();
    const expectedPubkey = Keypair.generate().publicKey.toBase58();
    const config = stubConfig({
      'solana.cluster': 'devnet',
      'faucet.rwtTreasuryPubkey': expectedPubkey,
      FAUCET_RWT_TREASURY_KEYPAIR_B64: kpToB64(wrongKp),
    });
    expect(() => buildRwtTreasuryKeypair(config)).toThrow(/pubkey mismatch/i);
    expect(() => buildRwtTreasuryKeypair(config)).toThrow(new RegExp(`expected ${expectedPubkey}`));
  });

  it('falls back to DEFAULT_EXPECTED_RWT_TREASURY when the env pubkey is unset', () => {
    const randomKp = Keypair.generate();
    const config = stubConfig({
      'solana.cluster': 'devnet',
      // faucet.rwtTreasuryPubkey intentionally absent
      FAUCET_RWT_TREASURY_KEYPAIR_B64: kpToB64(randomKp),
    });
    expect(() => buildRwtTreasuryKeypair(config)).toThrow(
      new RegExp(`expected ${DEFAULT_EXPECTED_RWT_TREASURY}`),
    );
  });
});
