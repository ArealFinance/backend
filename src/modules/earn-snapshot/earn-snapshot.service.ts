import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Connection, PublicKey } from '@solana/web3.js';
import { Repository } from 'typeorm';

import { SOLANA_CONNECTION } from '../../common/solana/connection.module.js';
import { EarnSnapshot } from '../../entities/earn-snapshot.entity.js';
import {
  EARN_CONFIG_SEED,
  STAKING_CONFIG_SEED,
  calculateNav,
  calculateRate,
  calculateTvl,
  decodeEarnConfig,
  decodeStakingConfig,
  resolveEarnProgramId,
  resolveStakingProgramId,
} from './earn-onchain.js';

/**
 * Earn vault snapshot writer.
 *
 * Every 5 minutes: read EarnConfig + StakingConfig (PDAs derived from the
 * pinned, env-overridable earn/staking program IDs) and both relevant mint
 * supplies, compute
 * { bookNav, strwtRate, tvl, strwtSupply, rwtSupply, totalCapital } via the
 * pinned-offset decoders + pure bigint math (mirrors the on-chain Rust), and
 * append one `earn_snapshots` row.
 *
 * This service is PROD-GRADE and cluster-agnostic: it only READS chain state,
 * so it is safe to run on devnet now and mainnet later. It registers always.
 *
 * RPC resilience: any RPC / decode failure logs a warning and skips the tick.
 * Never throws out of the cron handler (an uncaught cron rejection would be an
 * unhandled promise rejection). A skipped tick just means a 5-min gap in the
 * series — the stats endpoint tolerates gaps.
 */
@Injectable()
export class EarnSnapshotService {
  private readonly logger = new Logger(EarnSnapshotService.name);
  private readonly earnConfigPda: PublicKey;
  private readonly stakingConfigPda: PublicKey;

  constructor(
    @Inject(SOLANA_CONNECTION) private readonly conn: Connection,
    @InjectRepository(EarnSnapshot)
    private readonly snapshots: Repository<EarnSnapshot>,
    private readonly config: ConfigService,
  ) {
    // Derive the singleton config PDAs from the pinned (env-overridable)
    // program IDs. Anti-drift: a program redeploy propagates via the
    // EARN_PROGRAM_ID / STAKING_PROGRAM_ID env without a code change.
    const earnProgramId = resolveEarnProgramId(this.config.get<string>('earn.programId'));
    const stakingProgramId = resolveStakingProgramId(
      this.config.get<string>('earn.stakingProgramId'),
    );
    this.earnConfigPda = PublicKey.findProgramAddressSync([EARN_CONFIG_SEED], earnProgramId)[0];
    this.stakingConfigPda = PublicKey.findProgramAddressSync(
      [STAKING_CONFIG_SEED],
      stakingProgramId,
    )[0];
  }

  /**
   * 5-minute cadence: read on-chain economics and append a snapshot row.
   *
   * Wrapped in a try/catch so a transient RPC outage never crashes the worker.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async snapshotEarn(): Promise<void> {
    try {
      const row = await this.computeSnapshot();
      if (!row) return; // computeSnapshot already logged the skip reason
      await this.snapshots.insert(row);
      this.logger.log(
        `earn snapshot: nav=${row.bookNav} rate=${row.strwtRate} tvl=${row.totalCapital} rwtSupply=${row.rwtSupply} strwtSupply=${row.strwtSupply}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`earn snapshot tick skipped: ${msg}`);
    }
  }

  /**
   * Read + decode + compute one snapshot row, or `null` if any input is
   * unavailable (account missing, supply read failed). Extracted so the cron
   * handler stays a thin try/catch wrapper and so a future backfill CLI can
   * reuse the same computation.
   */
  async computeSnapshot(): Promise<Partial<EarnSnapshot> | null> {
    const [earnInfo, stakingInfo] = await Promise.all([
      this.conn.getAccountInfo(this.earnConfigPda, 'confirmed'),
      this.conn.getAccountInfo(this.stakingConfigPda, 'confirmed'),
    ]);

    if (!earnInfo) {
      this.logger.warn(`EarnConfig not found at ${this.earnConfigPda.toBase58()}`);
      return null;
    }
    if (!stakingInfo) {
      this.logger.warn(`StakingConfig not found at ${this.stakingConfigPda.toBase58()}`);
      return null;
    }

    const earn = decodeEarnConfig(earnInfo.data);
    const staking = decodeStakingConfig(stakingInfo.data);

    // Mint supplies: earn-RWT (NAV denominator) and stRWT (rate denominator).
    const [rwtSupplyResp, strwtSupplyResp] = await Promise.all([
      this.conn.getTokenSupply(earn.rwtMint, 'confirmed'),
      this.conn.getTokenSupply(staking.strwtMint, 'confirmed'),
    ]);
    const rwtSupply = BigInt(rwtSupplyResp.value.amount);
    const strwtSupply = BigInt(strwtSupplyResp.value.amount);

    const bookNav = calculateNav(earn.totalInvestedCapital, rwtSupply);
    const strwtRate = calculateRate(staking.totalRwtActive, strwtSupply);
    const tvl = calculateTvl(rwtSupply, bookNav);

    return {
      ts: new Date(),
      bookNav: bookNav.toString(),
      strwtRate: strwtRate.toString(),
      tvl: tvl.toString(),
      strwtSupply: strwtSupply.toString(),
      rwtSupply: rwtSupply.toString(),
      totalCapital: earn.totalInvestedCapital.toString(),
    };
  }
}
