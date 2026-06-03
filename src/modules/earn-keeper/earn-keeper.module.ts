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
//   Gate 3 — Program/mint pin: assertDevnetPins() reports a failure at boot if
//            the SDK's devnet earn/staking program IDs or the pinned earn-RWT /
//            stRWT / EarnConfig / StakingConfig addresses don't equal the
//            expected devnet constants.
//   Gate 4 — RPC gate:        enforced at runtime in the service (gatesPass)
//            and at boot here — refuse if SOLANA_CLUSTER===devnet but the RPC
//            URL doesn't look like devnet/localhost.
//   Gate 5 — Explicit enable flag: DEVNET_YIELD_KEEPER_ENABLED must be true AND
//            cluster devnet — both required (enforced in the service's
//            gatesPass at runtime; surfaced in a boot log here).
//
// INERT-NOT-FATAL boot philosophy: the keeper is a NON-ESSENTIAL devnet
// component. A failing boot gate must disable ONLY the keeper, never crash the
// backend. The provider factory therefore NEVER throws — on any gate failure it
// logs a loud, actionable `logger.error(...)` and returns null (keeper inert).
// A null signer means the cron can never sign anything, which is the EXACT
// no-mainnet safety property we want; going inert is strictly safer than
// throwing (same no-sign guarantee, plus faucet/snapshot/`/earn/stats` stay up).
// This mirrors the runtime `gatesPass()` in the service, which already no-ops
// inertly rather than throwing.
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
import { isAllowedDevnetRpc, isDevnetCluster, isRunnableCluster } from './keeper-gates.js';
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
 * Result of a keeper boot gate check. On failure, `reason` is an
 * operator-facing, actionable description of WHICH gate failed and WHY (logged
 * as `logger.error` by the provider factory before the keeper goes inert).
 */
export type GateResult = { ok: true } | { ok: false; reason: string };

/**
 * Gate 3 (+ Gate 4 at boot) — verify the keeper is pointed at the known devnet
 * earn/staking stack before letting it sign anything. Returns a GateResult
 * instead of throwing: a mismatch makes the keeper INERT (provider returns
 * null), it does NOT crash the backend. Only meaningfully invoked on
 * devnet/localnet (the keypair provider returns null off those clusters, so the
 * keeper is already inert and the pins are moot).
 */
export function assertDevnetPins(config: ConfigService): GateResult {
  const cluster = config.get<SolanaCluster>('solana.cluster');
  const earnProgramId = resolveEarnProgramId(config.get<string>('earn.programId'));
  const stakingProgramId = resolveStakingProgramId(config.get<string>('earn.stakingProgramId'));

  // Gate 3a — program IDs must equal the expected devnet pins.
  if (earnProgramId.toBase58() !== EXPECTED_EARN_PROGRAM_ID) {
    return {
      ok: false,
      reason: `keeper Gate 3: earn program ID mismatch (expected ${EXPECTED_EARN_PROGRAM_ID}, got ${earnProgramId.toBase58()})`,
    };
  }
  if (stakingProgramId.toBase58() !== EXPECTED_STAKING_PROGRAM_ID) {
    return {
      ok: false,
      reason: `keeper Gate 3: staking program ID mismatch (expected ${EXPECTED_STAKING_PROGRAM_ID}, got ${stakingProgramId.toBase58()})`,
    };
  }

  // Gate 3b — derived config PDAs must equal the pinned literals.
  const earnPda = PublicKey.findProgramAddressSync([EARN_CONFIG_SEED], earnProgramId)[0];
  const stakingPda = PublicKey.findProgramAddressSync([STAKING_CONFIG_SEED], stakingProgramId)[0];
  if (earnPda.toBase58() !== EARN_CONFIG_PDA) {
    return {
      ok: false,
      reason: `keeper Gate 3: EarnConfig PDA mismatch (expected ${EARN_CONFIG_PDA}, got ${earnPda.toBase58()})`,
    };
  }
  if (stakingPda.toBase58() !== STAKING_CONFIG_PDA) {
    return {
      ok: false,
      reason: `keeper Gate 3: StakingConfig PDA mismatch (expected ${STAKING_CONFIG_PDA}, got ${stakingPda.toBase58()})`,
    };
  }

  // Gate 3c — the pinned mints must parse (catches a typo at boot, not tick).
  // The on-chain rwt_mint / strwt_mint are validated by the programs at tx
  // time; here we just assert the constants are well-formed base58.
  try {
    void new PublicKey(EARN_RWT_MINT);
    void new PublicKey(STRWT_MINT);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `keeper Gate 3: pinned mint constant is malformed base58 (${msg})` };
  }

  // Gate 4 (boot half) — on devnet, the RPC must be a host-anchored devnet host.
  // A coincidental substring (e.g. a mainnet host with a `/devnet` path) is
  // rejected: we parse the URL and match the EXACT hostname against the
  // allowlist (see isAllowedDevnetRpc). Fail-closed.
  if (isDevnetCluster(cluster)) {
    const rpcUrl = config.get<string>('solana.rpcUrl') ?? '';
    if (!isAllowedDevnetRpc(rpcUrl)) {
      return {
        ok: false,
        reason: `keeper Gate 4: cluster is devnet but RPC URL host is not on the devnet allowlist (rpcUrl host rejected)`,
      };
    }
  }

  return { ok: true };
}

/**
 * Gate 1 + Gate 2 — build the keeper signer keypair, or null off
 * devnet/localnet. On devnet/localnet, verifies the Gate 3/4 pins AND that the
 * loaded keypair matches the expected deployer pubkey (env-supplied or
 * fallback).
 *
 * INERT-NOT-FATAL: this NEVER throws. Any gate failure (cluster not runnable,
 * pin/RPC mismatch, missing/malformed keypair env, signer pubkey mismatch) logs
 * a loud, actionable `logger.error(...)` and returns null → the keeper is inert
 * and can never sign, while the rest of the backend boots normally. A null
 * signer is the exact no-mainnet safety property: no key, no signature.
 *
 * Exported so the boot-time pin can be unit-tested without standing up the
 * whole module.
 */
export function buildKeeperAuthorityKeypair(config: ConfigService): Keypair | null {
  const logger = new Logger('EarnKeeperModule');
  const cluster = config.get<SolanaCluster>('solana.cluster');

  // Gate 1 — cluster gate (fail-closed). null off the recognised devnet/local
  // clusters → keeper inert. A missing/typo'd cluster is NEVER coerced to
  // devnet (isRunnableCluster only matches an explicit known value). This is a
  // normal/expected off-devnet state (e.g. mainnet), so it's a silent inert —
  // not an error — to avoid noisy logs on every non-devnet deploy.
  if (!isRunnableCluster(cluster)) return null;

  // Gates 3 + 4 — verify the keeper would point at the right stack. On a
  // mismatch, go INERT (return null) with a loud error rather than throwing
  // (which would crash the whole backend during Nest bootstrap).
  const pins = assertDevnetPins(config);
  if (!pins.ok) {
    logger.error(
      `${pins.reason} — keeper DISABLED (inert). The backend will boot normally; ` +
        `fix the keeper config and redeploy to re-enable it.`,
    );
    return null;
  }

  // Gate 2 — load + pin the signer keypair. loadKeypairFromB64Env throws if the
  // env var is missing/malformed; catch it so a misconfigured keypair disables
  // ONLY the keeper instead of crashing the app.
  let kp: Keypair;
  try {
    kp = loadKeypairFromB64Env('earnKeeper.authorityKeypairB64', 'DEVNET_YIELD_KEEPER', config);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(
      `keeper Gate 2: failed to load signer keypair (${msg}) — keeper DISABLED (inert). ` +
        `The backend will boot normally; set a valid DEVNET_YIELD_KEEPER keypair and redeploy.`,
    );
    return null;
  }

  const expected = resolveExpectedKeeperAuthority(config.get<string>('earnKeeper.authorityPubkey'));
  const actual = kp.publicKey.toBase58();
  if (actual !== expected) {
    logger.error(
      `keeper Gate 2: signer pubkey mismatch (expected ${expected}, got ${actual}) — ` +
        `keeper DISABLED (inert). The backend will boot normally; fix the keypair and redeploy.`,
    );
    return null;
  }

  // Gate 5 — surface whether the master enable flag is on (the runtime
  // gatesPass enforces it; this is just an operator-facing boot log).
  const enabled = config.get<boolean>('earnKeeper.enabled');
  logger.log(
    `keeper signer loaded: ${actual} (cluster=${cluster}, enabled=${enabled}) — keeper ${enabled && isDevnetCluster(cluster) ? 'ACTIVE' : 'inert'}`,
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
