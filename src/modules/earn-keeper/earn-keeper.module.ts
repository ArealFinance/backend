// DEVNET-ONLY — must never run on mainnet.
//
// Registers the yield keeper but makes it INERT unless FIVE independent
// fail-closed gates ALL pass. The module is always imported by AppModule so the
// cron is registered, but every path the cron could take is gated:
//
//   Gate 1 — Cluster gate:   buildKeeperAuthorityKeypair() returns null unless
//            SOLANA_CLUSTER === 'devnet' (localnet too, for local dev). The
//            service's runtime gatesPass() additionally requires === 'devnet'.
//   Gate 2 — Keypair provider: returns null off devnet/localnet → the cron
//            cannot sign → no-op. (Same fail-closed pattern as the faucet.)
//   Gate 3 — Program/mint pin: assertDevnetPins() throws at boot if the SDK's
//            devnet earn/staking program IDs or the pinned earn-RWT / stRWT /
//            EarnConfig / StakingConfig addresses don't equal the expected
//            devnet constants — refuses to boot on a mismatch.
//   Gate 4 — RPC gate:        enforced at runtime in the service (gatesPass)
//            and at boot here — refuse if SOLANA_CLUSTER===devnet but the RPC
//            URL doesn't look like devnet/localhost.
//   Gate 5 — Explicit enable flag: DEVNET_YIELD_KEEPER_ENABLED must be true AND
//            cluster devnet — both required (enforced in the service's
//            gatesPass at runtime; surfaced in a boot log here).
//
// The signing keypair is the devnet deployer (8ddRxwGn…) — the earn authority,
// the staking reward_depositor, AND the earn-USDC mint authority.

import { Logger, Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair, PublicKey } from '@solana/web3.js';

import type { SolanaCluster } from '../../config/configuration.js';
import { loadKeypairFromB64Env } from '../faucet/spl/keypair-loader.js';
import {
  EARN_CONFIG_PDA,
  EARN_CONFIG_SEED,
  EARN_RWT_MINT,
  STAKING_CONFIG_PDA,
  STAKING_CONFIG_SEED,
  STRWT_MINT,
  resolveEarnProgramId,
  resolveStakingProgramId,
} from '../earn-snapshot/earn-onchain.js';
import { EarnKeeperService } from './earn-keeper.service.js';
import { KEEPER_AUTHORITY_KEYPAIR } from './keeper.tokens.js';

/** Expected devnet deployer pubkey — the keeper signer boot-time pin. */
const DEFAULT_EXPECTED_KEEPER_AUTHORITY = '8ddRxwGnC1MD5ZCf22eLAne77Rput8itQbTjMr93xYvq';

/** Expected SDK devnet program IDs (Gate 3 pin). */
const EXPECTED_EARN_PROGRAM_ID = 'HGh7TcuqUbTRrFTYBUtsTctAEEmsANWnDxeWcbgqMg8b';
const EXPECTED_STAKING_PROGRAM_ID = 'CmKXHk3u6pDUC6Q11Le6gmhCgENQSFvduisXb7guUGoL';

export function resolveExpectedKeeperAuthority(envValue?: string | null): string {
  const trimmed = envValue?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_EXPECTED_KEEPER_AUTHORITY;
}

/**
 * Gate 3 (+ Gate 4 at boot) — assert the keeper is pointed at the known devnet
 * earn/staking stack before letting it sign anything. Throws (refuses to boot)
 * on any mismatch. Only invoked on devnet/localnet (the keypair provider
 * returns null otherwise, so the keeper is already inert and the pins are moot).
 */
export function assertDevnetPins(config: ConfigService): void {
  const cluster = config.get<SolanaCluster>('solana.cluster');
  const earnProgramId = resolveEarnProgramId(config.get<string>('earn.programId'));
  const stakingProgramId = resolveStakingProgramId(config.get<string>('earn.stakingProgramId'));

  // Gate 3a — program IDs must equal the expected devnet pins.
  if (earnProgramId.toBase58() !== EXPECTED_EARN_PROGRAM_ID) {
    throw new Error(
      `keeper Gate 3: earn program ID mismatch (expected ${EXPECTED_EARN_PROGRAM_ID}, got ${earnProgramId.toBase58()}) — refusing to boot`,
    );
  }
  if (stakingProgramId.toBase58() !== EXPECTED_STAKING_PROGRAM_ID) {
    throw new Error(
      `keeper Gate 3: staking program ID mismatch (expected ${EXPECTED_STAKING_PROGRAM_ID}, got ${stakingProgramId.toBase58()}) — refusing to boot`,
    );
  }

  // Gate 3b — derived config PDAs must equal the pinned literals.
  const earnPda = PublicKey.findProgramAddressSync([EARN_CONFIG_SEED], earnProgramId)[0];
  const stakingPda = PublicKey.findProgramAddressSync([STAKING_CONFIG_SEED], stakingProgramId)[0];
  if (earnPda.toBase58() !== EARN_CONFIG_PDA) {
    throw new Error(
      `keeper Gate 3: EarnConfig PDA mismatch (expected ${EARN_CONFIG_PDA}, got ${earnPda.toBase58()}) — refusing to boot`,
    );
  }
  if (stakingPda.toBase58() !== STAKING_CONFIG_PDA) {
    throw new Error(
      `keeper Gate 3: StakingConfig PDA mismatch (expected ${STAKING_CONFIG_PDA}, got ${stakingPda.toBase58()}) — refusing to boot`,
    );
  }

  // Gate 3c — the pinned mints must parse (catches a typo at boot, not tick).
  // The on-chain rwt_mint / strwt_mint are validated by the programs at tx
  // time; here we just assert the constants are well-formed base58.
  void new PublicKey(EARN_RWT_MINT);
  void new PublicKey(STRWT_MINT);

  // Gate 4 (boot half) — on devnet, the RPC must look like devnet/localhost.
  if (cluster === 'devnet') {
    const rpcUrl = config.get<string>('solana.rpcUrl') ?? '';
    if (!/devnet|localhost|127\.0\.0\.1/.test(rpcUrl)) {
      throw new Error(
        'keeper Gate 4: cluster is devnet but RPC URL does not look like devnet/localhost — refusing to boot',
      );
    }
  }
}

/**
 * Gate 1 + Gate 2 — build the keeper signer keypair, or null off
 * devnet/localnet. On devnet/localnet, asserts the keypair matches the expected
 * deployer pubkey (env-supplied or fallback) AND runs the Gate 3/4 pins.
 *
 * Exported so the boot-time pin can be unit-tested without standing up the
 * whole module.
 */
export function buildKeeperAuthorityKeypair(config: ConfigService): Keypair | null {
  const cluster = config.get<SolanaCluster>('solana.cluster');
  // Gate 1 — cluster gate. null off devnet/localnet → keeper inert.
  if (cluster !== 'devnet' && cluster !== 'localnet') return null;

  const logger = new Logger('EarnKeeperModule');

  // Gates 3 + 4 — refuse to boot if the keeper would point at the wrong stack.
  assertDevnetPins(config);

  const kp = loadKeypairFromB64Env('earnKeeper.authorityKeypairB64', 'DEVNET_YIELD_KEEPER', config);
  const expected = resolveExpectedKeeperAuthority(config.get<string>('earnKeeper.authorityPubkey'));
  const actual = kp.publicKey.toBase58();
  if (actual !== expected) {
    throw new Error(
      `keeper Gate 2: signer pubkey mismatch (expected ${expected}, got ${actual}) — refusing to boot`,
    );
  }

  // Gate 5 — surface whether the master enable flag is on (the runtime
  // gatesPass enforces it; this is just an operator-facing boot log).
  const enabled = config.get<boolean>('earnKeeper.enabled');
  logger.log(
    `keeper signer loaded: ${actual} (cluster=${cluster}, enabled=${enabled}) — keeper ${enabled && cluster === 'devnet' ? 'ACTIVE' : 'inert'}`,
  );
  return kp;
}

const keeperAuthorityProvider: FactoryProvider<Keypair | null> = {
  provide: KEEPER_AUTHORITY_KEYPAIR,
  inject: [ConfigService],
  useFactory: buildKeeperAuthorityKeypair,
};

@Module({
  providers: [EarnKeeperService, keeperAuthorityProvider],
})
export class EarnKeeperModule {}
