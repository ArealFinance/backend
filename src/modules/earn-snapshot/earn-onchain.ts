/**
 * Earn / staking on-chain constants + minimal account decoders.
 *
 * Shared by the earn-snapshot service (reads) and the devnet yield keeper
 * (reads + writes). Deliberately self-contained: we do NOT import the SDK's
 * `parseEarnConfig` / `parseStakingConfig` here because the `@areal/sdk`
 * `programs/earn` and `programs/staking` subpaths are NOT listed in the SDK's
 * package `exports` map (only the 5 main programs are). Importing them from the
 * backend would resolve to deep `dist/...` paths that the package author has
 * not committed to keeping stable. Instead we pin the byte offsets here,
 * verified against the Rust `#[account]` structs (repr(C, packed), 8-byte
 * discriminator prefix) AND against live devnet account data.
 *
 * Layout verification (offsets are relative to the start of `account.data`,
 * i.e. INCLUDING the 8-byte Arlex discriminator):
 *
 *   EarnConfig (contracts/earn/src/state.rs, repr(C,packed), SIZE=253, SPACE=261)
 *     8   total_invested_capital : u128 (16 bytes, LE)   <- Book NAV numerator
 *     24  authority              : [u8;32]
 *     56  pending_authority      : [u8;32]
 *     88  has_pending            : bool (1)
 *     89  pause_authority        : [u8;32]
 *     121 is_paused              : bool (1)
 *     122 mint_fee_bps           : u16 (2)
 *     124 basket_vault           : [u8;32]
 *     156 dao_fee_destination    : [u8;32]
 *     188 rwt_mint               : [u8;32]   <- earn-RWT mint
 *     220 usdc_mint              : [u8;32]   <- earn USDC mint
 *     252 min_mint_amount        : u64 (8)
 *     260 bump                   : u8 (1)
 *
 *   StakingConfig (contracts/staking/src/state.rs, repr(C,packed), SIZE=259, SPACE=267)
 *     8   authority         : [u8;32]
 *     40  pending_authority : [u8;32]
 *     72  has_pending       : bool (1)
 *     73  pause_authority   : [u8;32]
 *     105 is_paused         : bool (1)
 *     106 rwt_mint          : [u8;32]   <- staked token (earn-RWT)
 *     138 strwt_mint        : [u8;32]   <- share token
 *     170 reward_depositor  : [u8;32]   <- only caller of deposit_rewards (= deployer)
 *     202 pool_vault        : [u8;32]   <- RWT ATA owned by StakingConfig PDA
 *     234 total_rwt_active  : u64 (8)   <- rate numerator
 *     242 total_rwt_reserved: u64 (8)
 *     250 cooldown_seconds  : i64 (8)
 *     258 min_stake_amount  : u64 (8)
 *     266 bump              : u8 (1)
 *
 * Live devnet cross-check (2026-06-03, earn=HGh7Tcuq…, staking=CmKXHk3u…):
 *   EarnConfig.total_invested_capital = 1_057_000_000, rwt_mint = 8hJPUC…,
 *   usdc_mint = 5rrpFY…, basket_vault = B34MHT…, dao_fee_destination = 7eU9Ye…
 *   StakingConfig.rwt_mint = 8hJPUC…, strwt_mint = EnvY1tsk…,
 *   reward_depositor = 8ddRxwGn… (deployer), pool_vault = C4VTQq…,
 *   total_rwt_active = 15_000_000 → NAV = $1.000000, rate = 10.000000.
 */

import { PublicKey } from '@solana/web3.js';

// ─── Scaling constants (from contracts/earn/src/constants.rs and
//     contracts/staking/src/constants.rs) ────────────────────────────────────

/** 6-decimal fixed-point scale for NAV (matches USDC decimals). */
export const NAV_SCALE = 1_000_000n;
/** $1.00 NAV when earn-RWT supply == 0. */
export const INITIAL_NAV = NAV_SCALE;
/** 6-decimal fixed-point scale for the stRWT→RWT rate. */
export const RATE_SCALE = 1_000_000n;
/** Virtual assets offset (10 RWT in 6-dec) — bootstrap-rate numerator side. */
export const VIRTUAL_ASSETS = 10_000_000n;
/** Virtual shares offset (1 stRWT in 6-dec) — bootstrap-rate denominator side. */
export const VIRTUAL_SHARES = 1_000_000n;

/** earn-RWT / stRWT / earn-USDC all use 6 decimals. */
export const TOKEN_DECIMALS = 6;

// ─── Pinned devnet account addresses (env-overridable in callers) ────────────
//
// These are the LIVE devnet singletons for the current (2026-05-31 re-bootstrap)
// earn/staking stack. They are derivable as PDAs from the program IDs in the
// SDK (`earn_config` / `staking_config` seeds), but we also pin the literals so
// the keeper's boot-time gate can assert the derived value equals the expected
// one — an extra anti-drift tripwire (mirrors the faucet mint-pin pattern).

/** EarnConfig PDA (seed ["earn_config"] under the earn program). */
export const EARN_CONFIG_PDA = 'H4DBeFKwZsVrhMmMFG7HSMEQckeCYdewuri28kQ3wT4p';
/** StakingConfig PDA (seed ["staking_config"] under the staking program). */
export const STAKING_CONFIG_PDA = 'BWb75dNXbJbteLsmKy58sfHj8nYVa6CqaDzJrWo1mP1R';
/** earn-RWT mint (EarnConfig.rwt_mint, also StakingConfig.rwt_mint). */
export const EARN_RWT_MINT = '8hJPUC4UNsiyBh5cosTA8RqY9TbBSmnxqkBb2sHJ5qzM';
/** stRWT share mint (StakingConfig.strwt_mint). */
export const STRWT_MINT = 'EnvY1tsk4SLMPi4uThXCk4dbagtRJ1WdaTFYPKDroNwy';

/**
 * Earn / staking program IDs (devnet).
 *
 * Pinned here as literals — NOT sourced from `@areal/sdk/network` — because the
 * SDK's built `dist` (the version the backend links) predates the earn/staking
 * additions to `getProgramIds`, so `getProgramIds(cluster).earn` is `undefined`
 * at runtime. Pinning + an env override (`EARN_PROGRAM_ID` / `STAKING_PROGRAM_ID`)
 * mirrors the faucet's earn-USDC mint-pin discipline: a redeploy that rotates a
 * program ID propagates via env without a code change, and the keeper's Gate 3
 * asserts the resolved value matches these expected constants.
 *
 * Source of truth: `data/devnet-addresses.json` (2026-05-31 re-bootstrap) and
 * `sdk/src/network/program-ids.ts`.
 */
export const EARN_PROGRAM_ID = 'HGh7TcuqUbTRrFTYBUtsTctAEEmsANWnDxeWcbgqMg8b';
export const STAKING_PROGRAM_ID = 'CmKXHk3u6pDUC6Q11Le6gmhCgENQSFvduisXb7guUGoL';

/** Resolve the earn program ID — `EARN_PROGRAM_ID` env override > pinned literal. */
export function resolveEarnProgramId(envValue?: string | null): PublicKey {
  const trimmed = envValue?.trim();
  return new PublicKey(trimmed && trimmed.length > 0 ? trimmed : EARN_PROGRAM_ID);
}

/** Resolve the staking program ID — `STAKING_PROGRAM_ID` env override > pinned literal. */
export function resolveStakingProgramId(envValue?: string | null): PublicKey {
  const trimmed = envValue?.trim();
  return new PublicKey(trimmed && trimmed.length > 0 ? trimmed : STAKING_PROGRAM_ID);
}

/** PDA seeds (must match the Rust `EARN_CONFIG_SEED` / `STAKING_CONFIG_SEED`). */
export const EARN_CONFIG_SEED = Buffer.from('earn_config');
export const STAKING_CONFIG_SEED = Buffer.from('staking_config');

// ─── Offset constants (see header comment for the full layout proof) ─────────

const EARN_OFF = {
  totalInvestedCapital: 8, // u128
  basketVault: 124,
  daoFeeDestination: 156,
  rwtMint: 188,
  usdcMint: 220,
} as const;

const STAKING_OFF = {
  rwtMint: 106,
  strwtMint: 138,
  rewardDepositor: 170,
  poolVault: 202,
  totalRwtActive: 234, // u64
  totalRwtReserved: 242, // u64
} as const;

const EARN_DISCRIMINATOR = Buffer.from([0x8f, 0x6e, 0x3f, 0xb5, 0x95, 0x8c, 0xbe, 0x90]);
const STAKING_DISCRIMINATOR = Buffer.from([0x2d, 0x86, 0xfc, 0x52, 0x25, 0x39, 0x54, 0x19]);

function readU128LE(buf: Buffer, off: number): bigint {
  let v = 0n;
  for (let i = 0; i < 16; i++) {
    v += BigInt(buf[off + i]) << (8n * BigInt(i));
  }
  return v;
}

function readPubkey(buf: Buffer, off: number): PublicKey {
  return new PublicKey(buf.subarray(off, off + 32));
}

/** Decoded EarnConfig fields the backend needs (NAV inputs + wiring). */
export interface DecodedEarnConfig {
  totalInvestedCapital: bigint;
  basketVault: PublicKey;
  daoFeeDestination: PublicKey;
  rwtMint: PublicKey;
  usdcMint: PublicKey;
}

/**
 * Decode an EarnConfig account from raw `account.data`.
 *
 * Throws if the discriminator doesn't match (guards against decoding the wrong
 * account — e.g. a stale PDA from the abandoned v1 program) or the buffer is
 * too short. Callers should surface the throw as a skipped tick, never a crash.
 */
export function decodeEarnConfig(data: Buffer): DecodedEarnConfig {
  if (data.length < 261) {
    throw new Error(`EarnConfig too short: ${data.length} bytes (expected >= 261)`);
  }
  if (!data.subarray(0, 8).equals(EARN_DISCRIMINATOR)) {
    throw new Error('EarnConfig discriminator mismatch — wrong account?');
  }
  return {
    totalInvestedCapital: readU128LE(data, EARN_OFF.totalInvestedCapital),
    basketVault: readPubkey(data, EARN_OFF.basketVault),
    daoFeeDestination: readPubkey(data, EARN_OFF.daoFeeDestination),
    rwtMint: readPubkey(data, EARN_OFF.rwtMint),
    usdcMint: readPubkey(data, EARN_OFF.usdcMint),
  };
}

/** Decoded StakingConfig fields the backend needs (rate inputs + wiring). */
export interface DecodedStakingConfig {
  rwtMint: PublicKey;
  strwtMint: PublicKey;
  rewardDepositor: PublicKey;
  poolVault: PublicKey;
  totalRwtActive: bigint;
  totalRwtReserved: bigint;
}

/**
 * Decode a StakingConfig account from raw `account.data`. Same discriminator /
 * length guards as `decodeEarnConfig`.
 */
export function decodeStakingConfig(data: Buffer): DecodedStakingConfig {
  if (data.length < 267) {
    throw new Error(`StakingConfig too short: ${data.length} bytes (expected >= 267)`);
  }
  if (!data.subarray(0, 8).equals(STAKING_DISCRIMINATOR)) {
    throw new Error('StakingConfig discriminator mismatch — wrong account?');
  }
  return {
    rwtMint: readPubkey(data, STAKING_OFF.rwtMint),
    strwtMint: readPubkey(data, STAKING_OFF.strwtMint),
    rewardDepositor: readPubkey(data, STAKING_OFF.rewardDepositor),
    poolVault: readPubkey(data, STAKING_OFF.poolVault),
    totalRwtActive: data.readBigUInt64LE(STAKING_OFF.totalRwtActive),
    totalRwtReserved: data.readBigUInt64LE(STAKING_OFF.totalRwtReserved),
  };
}

// ─── Pure math (mirrors contracts/earn/src/nav.rs and
//     contracts/staking/src/rate.rs exactly, in bigint) ────────────────────────

/**
 * Book NAV = total_invested_capital × NAV_SCALE / total_rwt_supply, in 6-dec
 * fixed-point. Returns INITIAL_NAV ($1.00) when supply == 0 (matches
 * `calculate_nav`'s zero-supply guard), and clamps to a floor of 1 so a tiny
 * capital / large supply never truncates to 0 NAV.
 */
export function calculateNav(capital: bigint, rwtSupply: bigint): bigint {
  if (rwtSupply === 0n) return INITIAL_NAV;
  const nav = (capital * NAV_SCALE) / rwtSupply;
  return nav > 1n ? nav : 1n;
}

/**
 * stRWT→RWT rate = (total_rwt_active + VIRTUAL_ASSETS) × RATE_SCALE /
 * (strwt_supply + VIRTUAL_SHARES), in 6-dec fixed-point. Mirrors
 * `rate_snapshot`. The virtual offsets make this well-defined even for an
 * empty pool (bootstrap rate = 10).
 */
export function calculateRate(totalRwtActive: bigint, strwtSupply: bigint): bigint {
  const assets = totalRwtActive + VIRTUAL_ASSETS;
  const shares = strwtSupply + VIRTUAL_SHARES;
  return (assets * RATE_SCALE) / shares;
}

/**
 * TVL (USD, in NAV_SCALE 6-dec fixed-point).
 *
 * Definition (documented): TVL = total_rwt_supply × bookNav / NAV_SCALE.
 * Because bookNav = capital × NAV_SCALE / supply, this collapses to
 * `total_invested_capital` — the basket capital backing all minted RWT, in
 * 6-dec USD. We compute it the long way (supply × nav) so the relationship is
 * explicit and the value tracks the stored capital exactly. This is the
 * "value of all minted RWT at Book NAV", i.e. the protocol's invested capital,
 * NOT the staked subset.
 */
export function calculateTvl(rwtSupply: bigint, bookNav: bigint): bigint {
  return (rwtSupply * bookNav) / NAV_SCALE;
}
