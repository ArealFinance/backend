import { Logger, Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@solana/web3.js';

import type { SolanaCluster } from '../../config/configuration.js';
import { FaucetController } from './faucet.controller.js';
import { FaucetService } from './faucet.service.js';
import { RwtFaucetService } from './rwt-faucet.service.js';
import { EarnUsdcFaucetService } from './earn-usdc-faucet.service.js';
import {
  resolveExpectedAuthority,
  resolveExpectedEarnUsdcAuthority,
  resolveExpectedRwtTreasury,
} from './faucet.constants.js';
import {
  FAUCET_AUTHORITY_KEYPAIR,
  FAUCET_EARN_USDC_AUTHORITY_KEYPAIR,
  FAUCET_FUNDER_KEYPAIR,
  FAUCET_RWT_TREASURY_KEYPAIR,
} from './keypair.tokens.js';
import { faucetRedisProvider } from './redis.provider.js';
import { loadKeypairFromB64Env } from './spl/keypair-loader.js';

/**
 * Faucet module — ALWAYS registered in `AppModule`. The cluster gate
 * lives at two layers:
 *   - `LocalnetOnlyGuard` on the controller route: 404 outside localnet.
 *   - The keypair providers below: return `null` outside localnet, so
 *     even an internal caller of `FaucetService.claim` (e.g. a future
 *     job) can't bypass the guard and mint test-USDC against a real
 *     mint by accident.
 *
 * On localnet, the authority keypair is asserted to match the
 * expected authority pubkey. That expected value is resolved from the
 * `FAUCET_USDC_AUTHORITY` env var (the deployer pubkey supplied by the
 * deploy path), falling back to `DEFAULT_EXPECTED_AUTHORITY` — see
 * `resolveExpectedAuthority`. Sourcing from env means a test-validator
 * reset that rotates the deployer auto-propagates without a code change.
 * This catches the dangerous misconfig where an operator pastes a
 * real-mint authority keypair into the localnet env block.
 */

/**
 * Build the faucet USDC authority keypair from env, asserting it matches the
 * expected (env-supplied or fallback) deployer pubkey. Exported so the
 * boot-time safety pin can be unit-tested in isolation without standing up
 * the whole module (which would also open a real Redis connection).
 *
 * Returns `null` on any non-localnet cluster so an internal caller can never
 * mint test-USDC against a real mint. Throws on a pubkey mismatch — the
 * container then refuses to boot.
 */
export function buildFaucetAuthorityKeypair(config: ConfigService): Keypair | null {
  const cluster = config.get<SolanaCluster>('solana.cluster');
  if (cluster !== 'localnet') return null;
  const logger = new Logger('FaucetModule');
  const kp = loadKeypairFromB64Env(
    'FAUCET_USDC_AUTHORITY_KEYPAIR_B64',
    'FAUCET_USDC_AUTHORITY',
    config,
  );
  const expected = resolveExpectedAuthority(config.get<string>('faucet.usdcAuthorityPubkey'));
  const actual = kp.publicKey.toBase58();
  if (actual !== expected) {
    throw new Error(
      `FAUCET_USDC_AUTHORITY pubkey mismatch: expected ${expected}, got ${actual} — refusing to boot`,
    );
  }
  logger.log(`Faucet USDC authority loaded: ${actual}`);
  return kp;
}

const authorityKeypairProvider: FactoryProvider<Keypair | null> = {
  provide: FAUCET_AUTHORITY_KEYPAIR,
  inject: [ConfigService],
  useFactory: buildFaucetAuthorityKeypair,
};

/**
 * Build the RWT treasury keypair from env. Returns `null` outside
 * devnet/localnet so an internal caller can never accidentally drain a
 * real-mint treasury. On devnet/localnet the keypair MUST decode to the
 * expected treasury pubkey (env-supplied or fallback constant), else
 * boot fails — same anti-drift discipline as the USDC authority pin.
 *
 * Exported so the boot-time safety pin can be unit-tested without
 * standing up the whole module (which would open a real Redis connection).
 */
export function buildRwtTreasuryKeypair(config: ConfigService): Keypair | null {
  const cluster = config.get<SolanaCluster>('solana.cluster');
  if (cluster !== 'devnet' && cluster !== 'localnet') return null;
  const logger = new Logger('FaucetModule');
  const kp = loadKeypairFromB64Env(
    'FAUCET_RWT_TREASURY_KEYPAIR_B64',
    'FAUCET_RWT_TREASURY',
    config,
  );
  const expected = resolveExpectedRwtTreasury(config.get<string>('faucet.rwtTreasuryPubkey'));
  const actual = kp.publicKey.toBase58();
  if (actual !== expected) {
    throw new Error(
      `FAUCET_RWT_TREASURY pubkey mismatch: expected ${expected}, got ${actual} — refusing to boot`,
    );
  }
  logger.log(`Faucet RWT treasury loaded: ${actual}`);
  return kp;
}

const rwtTreasuryKeypairProvider: FactoryProvider<Keypair | null> = {
  provide: FAUCET_RWT_TREASURY_KEYPAIR,
  inject: [ConfigService],
  useFactory: buildRwtTreasuryKeypair,
};

/**
 * Build the earn-USDC mint-authority keypair from env. Returns `null` outside
 * devnet/localnet so an internal caller can never accidentally mint earn-USDC
 * against a real mint. On devnet/localnet the keypair MUST decode to the
 * expected earn authority pubkey (env-supplied or fallback constant), else boot
 * fails — same anti-drift discipline as the USDC authority pin. The earn
 * deployer HOLDS the mint authority (unlike the RWT treasury), so this faucet
 * uses MintTo.
 *
 * Exported so the boot-time safety pin can be unit-tested without standing up
 * the whole module (which would open a real Redis connection).
 */
export function buildEarnUsdcAuthorityKeypair(config: ConfigService): Keypair | null {
  const cluster = config.get<SolanaCluster>('solana.cluster');
  if (cluster !== 'devnet' && cluster !== 'localnet') return null;
  const logger = new Logger('FaucetModule');
  const kp = loadKeypairFromB64Env(
    'FAUCET_EARN_USDC_AUTHORITY_KEYPAIR_B64',
    'FAUCET_EARN_USDC_AUTHORITY',
    config,
  );
  const expected = resolveExpectedEarnUsdcAuthority(
    config.get<string>('faucet.earnUsdcAuthorityPubkey'),
  );
  const actual = kp.publicKey.toBase58();
  if (actual !== expected) {
    throw new Error(
      `FAUCET_EARN_USDC_AUTHORITY pubkey mismatch: expected ${expected}, got ${actual} — refusing to boot`,
    );
  }
  logger.log(`Faucet earn-USDC authority loaded: ${actual}`);
  return kp;
}

const earnUsdcAuthorityKeypairProvider: FactoryProvider<Keypair | null> = {
  provide: FAUCET_EARN_USDC_AUTHORITY_KEYPAIR,
  inject: [ConfigService],
  useFactory: buildEarnUsdcAuthorityKeypair,
};

const funderKeypairProvider: FactoryProvider<Keypair | null> = {
  provide: FAUCET_FUNDER_KEYPAIR,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Keypair | null => {
    // The funder pays SOL fees + ATA-create rent for all faucets, so it
    // must be loaded on any cluster where ANY faucet route is enabled.
    // Today that's localnet (USDC) and devnet/localnet (RWT, earn-USDC).
    // Mainnet still gets `null` here — keeps the "no funder == no faucet"
    // safety invariant.
    const cluster = config.get<SolanaCluster>('solana.cluster');
    if (cluster !== 'localnet' && cluster !== 'devnet') return null;
    const logger = new Logger('FaucetModule');
    const kp = loadKeypairFromB64Env('FAUCET_SOL_FUNDER_KEYPAIR_B64', 'FAUCET_SOL_FUNDER', config);
    logger.log(`Faucet SOL funder loaded: ${kp.publicKey.toBase58()}`);
    return kp;
  },
};

@Module({
  controllers: [FaucetController],
  providers: [
    FaucetService,
    RwtFaucetService,
    EarnUsdcFaucetService,
    faucetRedisProvider,
    authorityKeypairProvider,
    rwtTreasuryKeypairProvider,
    earnUsdcAuthorityKeypairProvider,
    funderKeypairProvider,
  ],
})
export class FaucetModule {}
