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
  STAKING_CONFIG_SEED,
  decodeEarnConfig,
  decodeStakingConfig,
  resolveEarnProgramId,
  resolveStakingProgramId,
} from '../earn-snapshot/earn-onchain.js';
import { buildAddToBasketIx, buildDepositRewardsIx } from './keeper-ix.js';
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
 * Devnet-only yield keeper.
 *
 * Per tick (1 min), when all gates pass:
 *   1. Read EarnConfig + StakingConfig on-chain (decode via pinned offsets).
 *   2. Compute per-minute rewards targeting `apyBps`:
 *        - deposit_rewards (raises rate): rwt ≈ total_rwt_active * apy / minPerYear
 *        - add_to_basket   (raises NAV) : usdc ≈ total_invested_capital * apy / minPerYear
 *   3. Source funds:
 *        - USDC for add_to_basket: MintTo into the deployer's USDC ATA (deployer
 *          IS the earn-USDC mint authority), then add_to_basket transfers it
 *          into basket_vault.
 *        - RWT for deposit_rewards: the deployer's pre-funded RWT ATA (the earn
 *          RWT mint authority is the EarnConfig PDA, NOT the deployer, so the
 *          keeper canNOT mint RWT — it draws from a pre-funded treasury). When
 *          the treasury runs low, the deposit_rewards instruction is skipped and
 *          a warning is logged; an operator tops up the deployer's RWT ATA.
 *   4. Batch MintTo + add_to_basket + deposit_rewards into ONE transaction (as
 *      many instructions as land in a single tx — they fit comfortably).
 *   5. Send + confirm; on any failure log + skip the tick (no crash, no retry).
 *
 * Floor / honesty behavior: each reward is floored to an integer base unit. On
 * a tiny pool a per-minute reward can round to 0 — we SKIP that instruction
 * rather than fake a deposit, so the APY the snapshot service derives stays
 * honest (no lumpy fake spikes). At 15 RWT active / 12% APY the per-minute RWT
 * reward is ~3 base units, comfortably above the floor.
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
    // Gate 1 — cluster.
    if (this.cluster() !== 'devnet') return false;
    // Gate 4 — RPC URL.
    const rpcUrl = this.config.get<string>('solana.rpcUrl') ?? '';
    if (!/devnet|localhost|127\.0\.0\.1/.test(rpcUrl)) {
      this.logger.warn('keeper inert: RPC URL does not look like devnet/localhost');
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

    const ixs: TransactionInstruction[] = [];

    // ── add_to_basket leg (raises Book NAV) ──────────────────────────────────
    // Source: MintTo earn-USDC into the deployer's USDC ATA (authority IS the
    // earn-USDC mint authority), then add_to_basket transfers it into the
    // basket vault. authority_source = dao_fee_destination (the deployer's
    // earn-USDC ATA == EarnConfig.dao_fee_destination on devnet).
    if (usdcReward >= MIN_REWARD_BASE_UNITS) {
      const authorityUsdcAta = findAta(authority.publicKey, earn.usdcMint);
      ixs.push(buildMintToIx(authority.publicKey, earn.usdcMint, authorityUsdcAta, usdcReward));
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
    } else {
      this.logger.debug(
        `keeper: usdc reward floored to 0 (capital=${earn.totalInvestedCapital}) — skipping add_to_basket`,
      );
    }

    // ── deposit_rewards leg (raises stRWT rate) ──────────────────────────────
    // Source: the deployer's pre-funded RWT ATA. The keeper canNOT mint RWT
    // (EarnConfig PDA holds that authority), so it draws from the treasury and
    // skips if the balance can't cover the reward.
    if (rwtReward >= MIN_REWARD_BASE_UNITS) {
      const depositorRwtAta = findAta(authority.publicKey, staking.rwtMint);
      const haveRwt = await this.tokenBalance(depositorRwtAta);
      if (haveRwt >= rwtReward) {
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
      } else {
        this.logger.warn(
          `keeper: RWT reward treasury low (have=${haveRwt} need=${rwtReward} ata=${depositorRwtAta.toBase58()}) — skipping deposit_rewards. Top up the deployer's RWT ATA.`,
        );
      }
    } else {
      this.logger.debug(
        `keeper: rwt reward floored to 0 (active=${staking.totalRwtActive}) — skipping deposit_rewards`,
      );
    }

    if (ixs.length === 0) {
      this.logger.debug('keeper: nothing to do this tick (all legs below floor/treasury)');
      return;
    }

    await this.sendBatched(authority, ixs);
    this.logger.log(
      `keeper tick: usdcReward=${usdcReward} rwtReward=${rwtReward} ixs=${ixs.length}`,
    );
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

  /** Read an SPL token account's amount; returns 0n if the account is missing. */
  private async tokenBalance(ata: PublicKey): Promise<bigint> {
    try {
      const resp = await this.conn.getTokenAccountBalance(ata, 'confirmed');
      return BigInt(resp.value.amount);
    } catch {
      return 0n;
    }
  }

  private cluster(): SolanaCluster {
    return (this.config.get<string>('solana.cluster') ?? 'devnet') as SolanaCluster;
  }
}
