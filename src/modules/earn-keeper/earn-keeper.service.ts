// DEVNET-ONLY — must never run on mainnet.
//
// This service simulates the real off-chain income distributor by depositing
// small on-chain rewards every minute so the stRWT rate and Book NAV genuinely
// move on devnet (killing the frontend's hardcoded APY/EARNED placeholders).
// It is gated by FIVE independent fail-closed checks (see earn-keeper.module.ts
// for gates 1-3+5 enforced at boot, and `tick()` below for the runtime cluster
// + keypair + RPC re-checks). Any single gate failing makes the cron a no-op.

import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import { SOLANA_CONNECTION } from '../../common/solana/connection.module.js';
import { buildMintToIx, findAta } from '../faucet/spl/spl-ix.js';
import {
  EARN_CONFIG_SEED,
  NAV_SCALE,
  STAKING_CONFIG_SEED,
  calculateNav,
  decodeEarnConfig,
  decodeStakingConfig,
  resolveEarnProgramId,
  resolveStakingProgramId,
  type DecodedEarnConfig,
} from '../earn-snapshot/earn-onchain.js';
import { buildAddToBasketIx, buildDepositRewardsIx, buildMintRwtIx } from './keeper-ix.js';
import { isAllowedDevnetRpc, isDevnetCluster } from './keeper-gates.js';
import { KEEPER_AUTHORITY_KEYPAIR } from './keeper.tokens.js';
import type { SolanaCluster } from '../../config/configuration.js';

/** Minutes in a 365-day year — the per-minute reward divisor. */
const MINUTES_PER_YEAR = 365 * 24 * 60;
/** Basis-point denominator. */
const BPS_DENOMINATOR = 10_000n;
/**
 * Minimum reward, in base units, for a single instruction. Below this we SKIP
 * the instruction (don't floor-to-zero a no-op tx) — see header on the
 * accumulation/floor behavior. 1 base unit = the smallest honest reward.
 */
const MIN_REWARD_BASE_UNITS = 1n;

/**
 * USDC body required (ceil) to mint at least `rwtOut` earn-RWT at Book NAV,
 * inverting the program's `rwt_out = floor(usdc × NAV_SCALE / nav)`. Ceil-dividing
 * guarantees the realised RWT out is >= rwtOut so the buffer never under-fills.
 *   body = ceil(rwtOut × nav / NAV_SCALE)
 */
export function usdcBodyForRwtOut(rwtOut: bigint, nav: bigint): bigint {
  return (rwtOut * nav + (NAV_SCALE - 1n)) / NAV_SCALE;
}

/**
 * mint_rwt fee (ceil) on a USDC body at `feeBps`, mirroring the program's
 * `fee = floor(usdc × fee_bps / 10_000)` but rounded UP so the deployer's minted
 * USDC always covers body + fee (a tiny over-mint is harmless; an under-mint
 * would fail the tx).
 *   fee = ceil(body × feeBps / 10_000)
 */
export function mintRwtFeeCeil(body: bigint, feeBps: bigint): bigint {
  return (body * feeBps + (BPS_DENOMINATOR - 1n)) / BPS_DENOMINATOR;
}

/**
 * Replenish mint sizing.
 *
 * The replenish step tops the deployer's RWT buffer back up by minting a CHUNK
 * via `mint_rwt`. The chunk targets `targetBufferRwt` RWT but the USDC body MUST
 * clear the on-chain `min_mint_amount` floor (`BelowMinMint` otherwise), so:
 *
 *   body = max(min_mint_amount, ceil(targetBufferRwt × nav / NAV_SCALE))
 *
 * On a tiny pool the buffer target rounds to a sub-$1 body, so the `max` raises
 * it to exactly $1.00 — the smallest legal mint — which still over-fills the
 * buffer (harmless; the surplus just feeds more ticks before the next mint).
 * Returns the body in USDC base units (the fee is computed separately on top).
 */
export function replenishMintBody(
  targetBufferRwt: bigint,
  nav: bigint,
  minMintAmount: bigint,
): bigint {
  const navBody = usdcBodyForRwtOut(targetBufferRwt, nav);
  return navBody > minMintAmount ? navBody : minMintAmount;
}

/**
 * Devnet-only yield keeper (buffered / replenish design).
 *
 * Per tick (1 min), when all gates pass, TWO independent legs in ONE tx —
 * neither can hit the contract's `min_mint_amount` floor, so neither reverts:
 *
 *   1. add_to_basket(usdcReward) — raises Book NAV. Source: MintTo `usdcReward`
 *      earn-USDC into the deployer's USDC ATA (the deployer IS the earn-USDC
 *      mint authority), then add_to_basket transfers it into basket_vault. No
 *      min guard → ALWAYS lands.
 *
 *   2. deposit_rewards(rwtReward) — raises the stRWT rate. Source: the deployer's
 *      EXISTING RWT ATA balance (a pre-minted buffer), NOT a fresh per-tick mint.
 *      A per-tick mint of `rwtReward` (≈3 base units on the live 15-RWT pool)
 *      would be a sub-$1 USDC body → `BelowMinMint` → the WHOLE atomic tx (incl.
 *      the NAV leg) reverts → permanent no-op. Drawing from the buffer avoids
 *      that entirely. If the buffer can't cover `rwtReward`, this leg is SKIPPED
 *      (the NAV leg still lands) and a replenish is triggered.
 *
 * Replenish (occasional, SEPARATE tx): when the RWT buffer drops below
 * `floorTicks × rwtReward`, mint a `bufferTicks × rwtReward` chunk via mint_rwt.
 * The mint body is raised to >= `min_mint_amount` so it ALWAYS clears the
 * on-chain floor. Done in its own tx so a (shouldn't-happen) failure can't
 * affect the per-tick legs. Self-sustaining: the deployer mints USDC freely,
 * mint_rwt converts it to RWT in ≥$1 chunks, the buffer feeds deposit_rewards.
 *
 * Floor / honesty behavior: each reward is floored to an integer base unit. On
 * a tiny pool a per-minute reward can round to 0 — we SKIP that leg rather than
 * fake a deposit, so the APY the snapshot service derives stays honest.
 *
 * Invariants preserved (enforced by the contracts; we just sequence correctly):
 *   - mint_rwt mints RWT at NAV and books the USDC body into capital, so Book
 *     NAV is unchanged by the replenish mint (supply + capital move in lockstep).
 *   - deposit_rewards moves RWT depositor→pool_vault and bumps total_rwt_active,
 *     keeping `pool_vault == active + reserved`.
 */
@Injectable()
export class EarnKeeperService {
  private readonly logger = new Logger(EarnKeeperService.name);
  private readonly earnConfigPda: PublicKey;
  private readonly stakingConfigPda: PublicKey;
  private readonly earnProgramId: PublicKey;
  private readonly stakingProgramId: PublicKey;

  constructor(
    @Inject(SOLANA_CONNECTION) private readonly conn: Connection,
    @Inject(KEEPER_AUTHORITY_KEYPAIR) private readonly authority: Keypair | null,
    private readonly config: ConfigService,
  ) {
    this.earnProgramId = resolveEarnProgramId(this.config.get<string>('earn.programId'));
    this.stakingProgramId = resolveStakingProgramId(
      this.config.get<string>('earn.stakingProgramId'),
    );
    this.earnConfigPda = PublicKey.findProgramAddressSync(
      [EARN_CONFIG_SEED],
      this.earnProgramId,
    )[0];
    this.stakingConfigPda = PublicKey.findProgramAddressSync(
      [STAKING_CONFIG_SEED],
      this.stakingProgramId,
    )[0];
  }

  /**
   * 1-minute cadence. The cron handler is a thin gate + try/catch wrapper; the
   * real work is in `runOnce`. Gates 1, 2, 4, 5 are re-asserted here at runtime
   * (gates 3 + 5 + the keypair pin also fire at boot in the module) so a config
   * change can never let the keeper act on a non-devnet target.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async tick(): Promise<void> {
    if (!this.gatesPass()) return;
    try {
      await this.runOnce();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`keeper tick skipped: ${msg}`);
    }
  }

  /**
   * Runtime gate re-check (defense in depth — the module also enforces these at
   * boot). ALL must hold:
   *   Gate 5: explicit enable flag.
   *   Gate 1: cluster === devnet.
   *   Gate 4: RPC URL contains devnet/localhost.
   *   Gate 2: signing keypair present (null off devnet).
   * Returns false (silent no-op) if any fails.
   */
  private gatesPass(): boolean {
    // Gate 5 — explicit enable flag.
    if (!this.config.get<boolean>('earnKeeper.enabled')) return false;
    // Gate 1 — cluster (fail-closed). Only the explicit 'devnet' cluster is
    // runtime-active; mainnet/testnet/typo'd → cluster() returns it unchanged
    // and isDevnetCluster rejects it.
    if (!isDevnetCluster(this.cluster())) return false;
    // Gate 4 — host-anchored RPC allowlist (no substring match; a mainnet host
    // with a `/devnet` path is rejected).
    if (!isAllowedDevnetRpc(this.config.get<string>('solana.rpcUrl'))) {
      this.logger.warn('keeper inert: RPC URL host is not on the devnet allowlist');
      return false;
    }
    // Gate 2 — keypair present.
    if (!this.authority) return false;
    return true;
  }

  private async runOnce(): Promise<void> {
    const authority = this.authority!; // gatesPass() guarantees non-null

    const [earnInfo, stakingInfo] = await Promise.all([
      this.conn.getAccountInfo(this.earnConfigPda, 'confirmed'),
      this.conn.getAccountInfo(this.stakingConfigPda, 'confirmed'),
    ]);
    if (!earnInfo || !stakingInfo) {
      this.logger.warn('keeper: earn/staking config account missing — skipping tick');
      return;
    }
    const earn = decodeEarnConfig(earnInfo.data);
    const staking = decodeStakingConfig(stakingInfo.data);

    const apyBps = BigInt(this.config.get<number>('earnKeeper.apyBps') ?? 1200);

    // Per-minute reward = principal * apyBps / BPS_DENOMINATOR / minutesPerYear.
    // Integer math throughout (floor) — no float drift.
    const rwtReward =
      (staking.totalRwtActive * apyBps) / BPS_DENOMINATOR / BigInt(MINUTES_PER_YEAR);
    const usdcReward =
      (earn.totalInvestedCapital * apyBps) / BPS_DENOMINATOR / BigInt(MINUTES_PER_YEAR);

    const authorityUsdcAta = findAta(authority.publicKey, earn.usdcMint);
    const depositorRwtAta = findAta(authority.publicKey, staking.rwtMint);

    // ── Per-tick legs (one tx; neither can hit min_mint_amount) ───────────────
    const ixs: TransactionInstruction[] = [];
    // earn-USDC the deployer must hold this tick = add_to_basket body only (the
    // deposit_rewards leg draws RWT from the existing buffer, not USDC).
    let usdcToMint = 0n;

    // add_to_basket leg (raises Book NAV). MintTo the body into the deployer USDC
    // ATA, then add_to_basket transfers it into basket_vault. No min guard.
    let didAddToBasket = false;
    if (usdcReward >= MIN_REWARD_BASE_UNITS) {
      usdcToMint += usdcReward;
      ixs.push(
        buildAddToBasketIx({
          earnProgramId: this.earnProgramId,
          authority: authority.publicKey,
          earnConfig: this.earnConfigPda,
          rwtMint: earn.rwtMint,
          authoritySource: authorityUsdcAta,
          basketVault: earn.basketVault,
          amount: usdcReward,
        }),
      );
      didAddToBasket = true;
    } else {
      this.logger.debug(
        `keeper: usdc reward floored to 0 (capital=${earn.totalInvestedCapital}) — skipping add_to_basket`,
      );
    }

    // deposit_rewards leg (raises stRWT rate). Draw rwtReward from the EXISTING
    // RWT buffer (deployer ATA) — NOT a fresh per-tick mint (that would be a
    // sub-$1 mint_rwt body → BelowMinMint → reverts the whole tick). If the
    // buffer can't cover it, skip the leg (NAV leg still lands) and rely on the
    // replenish below to top the buffer up for the next tick.
    let didDepositRewards = false;
    const rwtBalance = await this.tokenBalance(depositorRwtAta);
    if (rwtReward >= MIN_REWARD_BASE_UNITS) {
      if (rwtBalance >= rwtReward) {
        ixs.push(
          buildDepositRewardsIx({
            stakingProgramId: this.stakingProgramId,
            depositor: authority.publicKey,
            stakingConfig: this.stakingConfigPda,
            strwtMint: staking.strwtMint,
            depositorRwtAta,
            poolVault: staking.poolVault,
            rwtAmount: rwtReward,
          }),
        );
        didDepositRewards = true;
      } else {
        this.logger.warn(
          `keeper: RWT buffer too low (balance=${rwtBalance} < reward=${rwtReward}) — ` +
            `skipping deposit_rewards this tick; replenish will refill the buffer`,
        );
      }
    } else {
      this.logger.debug(
        `keeper: rwt reward floored to 0 (active=${staking.totalRwtActive}) — skipping deposit_rewards`,
      );
    }

    // Send the per-tick tx (if any leg is present). The MintTo (if needed) funds
    // the add_to_basket body; deposit_rewards needs no fresh USDC.
    if (ixs.length > 0) {
      const fundedIxs: TransactionInstruction[] =
        usdcToMint > 0n
          ? [buildMintToIx(authority.publicKey, earn.usdcMint, authorityUsdcAta, usdcToMint), ...ixs]
          : ixs;
      await this.sendBatched(authority, fundedIxs);
      this.logger.log(
        `keeper tick: usdcReward=${usdcReward} (addToBasket=${didAddToBasket}) ` +
          `rwtReward=${rwtReward} (depositRewards=${didDepositRewards}, buffer=${rwtBalance}) ` +
          `usdcMinted=${usdcToMint} ixs=${fundedIxs.length}`,
      );
    } else {
      this.logger.debug('keeper: nothing to do this tick (all legs below floor)');
    }

    // ── Replenish step (SEPARATE tx) ─────────────────────────────────────────
    // Top the RWT buffer back up if it dropped below the floor. Sized + min-mint
    // clamped so the mint always clears the on-chain $1 floor. Isolated in its
    // own tx so a failure here can never roll back the per-tick legs above.
    if (rwtReward >= MIN_REWARD_BASE_UNITS) {
      await this.maybeReplenish(authority, earn, staking.rwtMint, depositorRwtAta, rwtReward);
    }
  }

  /**
   * Mint a ≥$1 RWT chunk into the deployer's buffer ATA when the balance has
   * dropped below `floorTicks × rwtReward`. The chunk targets `bufferTicks ×
   * rwtReward` RWT; the USDC body is raised to >= `min_mint_amount` so the
   * mint_rwt can never revert with BelowMinMint. SEPARATE tx (own send).
   */
  private async maybeReplenish(
    authority: Keypair,
    earn: DecodedEarnConfig,
    rwtMint: PublicKey,
    depositorRwtAta: PublicKey,
    rwtReward: bigint,
  ): Promise<void> {
    const bufferTicks = BigInt(this.config.get<number>('earnKeeper.bufferTicks') ?? 1_440);
    const floorTicks = BigInt(this.config.get<number>('earnKeeper.floorTicks') ?? 60);

    const replenishFloor = rwtReward * floorTicks;
    const balance = await this.tokenBalance(depositorRwtAta);
    if (balance >= replenishFloor) return; // buffer still healthy

    // Target buffer top-up (RWT). mint_rwt's USDC body is clamped to the
    // on-chain floor so even a tiny target still produces a legal ≥$1 mint.
    const targetBufferRwt = rwtReward * bufferTicks;
    const rwtSupply = await this.mintSupply(rwtMint);
    const nav = calculateNav(earn.totalInvestedCapital, rwtSupply);
    const mintBody = replenishMintBody(targetBufferRwt, nav, earn.minMintAmount);
    const mintFee = mintRwtFeeCeil(mintBody, BigInt(earn.mintFeeBps));
    const usdcToMint = mintBody + mintFee;

    const authorityUsdcAta = findAta(authority.publicKey, earn.usdcMint);

    // MintTo body+fee USDC → mint_rwt deposits the body at NAV, mints RWT to the
    // deployer's buffer ATA. min_rwt_out = 1 (slippage floor; handler rejects 0)
    // — the chunk is sized so the realised RWT out is far above 1.
    const ixs: TransactionInstruction[] = [
      buildMintToIx(authority.publicKey, earn.usdcMint, authorityUsdcAta, usdcToMint),
      buildMintRwtIx({
        earnProgramId: this.earnProgramId,
        user: authority.publicKey,
        earnConfig: this.earnConfigPda,
        rwtMint: earn.rwtMint,
        userUsdc: authorityUsdcAta,
        userRwt: depositorRwtAta,
        basketVault: earn.basketVault,
        daoFeeDestination: earn.daoFeeDestination,
        usdcAmount: mintBody,
        minRwtOut: MIN_REWARD_BASE_UNITS,
      }),
    ];

    await this.sendBatched(authority, ixs);
    this.logger.log(
      `keeper replenish: buffer=${balance} < floor=${replenishFloor} → minted ` +
        `body=${mintBody} fee=${mintFee} (target=${targetBufferRwt} RWT, nav=${nav}, ` +
        `minMint=${earn.minMintAmount})`,
    );
  }

  /** Read an SPL mint's current supply; returns 0n if the mint is missing. */
  private async mintSupply(mint: PublicKey): Promise<bigint> {
    try {
      const resp = await this.conn.getTokenSupply(mint, 'confirmed');
      return BigInt(resp.value.amount);
    } catch {
      return 0n;
    }
  }

  /** Read an SPL token account's balance; returns 0n if the account is missing. */
  private async tokenBalance(ata: PublicKey): Promise<bigint> {
    try {
      const resp = await this.conn.getTokenAccountBalance(ata, 'confirmed');
      return BigInt(resp.value.amount);
    } catch {
      return 0n;
    }
  }

  /** Build, sign, send + confirm a single batched tx. Throws on failure. */
  private async sendBatched(authority: Keypair, ixs: TransactionInstruction[]): Promise<void> {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = authority.publicKey;
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    tx.sign(authority);
    const signature = await this.conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await this.conn.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, 'confirmed');
    this.logger.log(`keeper tx confirmed: ${signature}`);
  }

  /**
   * Read the configured cluster. NOTE: `configuration.ts` defaults an unset
   * `SOLANA_CLUSTER` to 'devnet' BEFORE this reads it, so `solana.cluster` is
   * effectively never undefined here — an unset env resolves to 'devnet', which
   * is the keeper's OWN cluster (devnet RPC, devnet program pins), not a leak
   * onto a foreign network. The fail-closed protection that matters is that
   * ONLY the exact 'devnet' string runs (isDevnetCluster): a mainnet/testnet/
   * typo'd value flows through unchanged and is rejected. We still return
   * `undefined` for an explicitly empty/whitespace value as a belt-and-braces
   * guard, but the real no-mainnet guarantee is the explicit-'devnet' check plus
   * the host-anchored RPC allowlist (Gate 4), not this defaulting.
   */
  private cluster(): SolanaCluster | undefined {
    const raw = this.config.get<string>('solana.cluster');
    const trimmed = raw?.trim();
    return trimmed && trimmed.length > 0 ? (trimmed as SolanaCluster) : undefined;
  }
}
