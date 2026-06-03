/**
 * Instruction builders for the devnet yield keeper.
 *
 * The SDK ships generated encoders for `add_to_basket` / `deposit_rewards`, but
 * the `@areal/sdk/earn` and `@areal/sdk/staking` subpaths are NOT in the SDK's
 * package `exports` map (only `network` etc. are exported). Rather than reach
 * into unstable deep `dist/...` paths, we inline the two instructions here.
 *
 * Both are trivial: an 8-byte Anchor-style discriminator + a single u64-LE arg.
 * Discriminators and account orderings are lifted verbatim from the generated
 * SDK files (`programs/earn/instructions.generated.ts`,
 * `programs/staking/instructions.generated.ts`) AND cross-checked against the
 * Rust `#[derive(Accounts)]` structs:
 *   - contracts/earn/src/instructions/add_to_basket.rs
 *   - contracts/staking/src/instructions/deposit_rewards.rs
 *
 * The account META ORDER is load-bearing — it must match the Rust struct field
 * order exactly. Signer / writable flags likewise mirror the `#[account(...)]`
 * attributes.
 */

import { PublicKey, TransactionInstruction } from '@solana/web3.js';

import { TOKEN_PROGRAM_ID } from '../faucet/spl/spl-ix.js';

/** `add_to_basket` discriminator (earn program). */
const ADD_TO_BASKET_DISCRIMINATOR = Buffer.from([0x82, 0x9b, 0xd0, 0x92, 0xfe, 0x14, 0x87, 0x38]);

/** `deposit_rewards` discriminator (staking program). */
const DEPOSIT_REWARDS_DISCRIMINATOR = Buffer.from([0x34, 0xf9, 0x70, 0x48, 0xce, 0xa1, 0xc4, 0x01]);

/**
 * `mint_rwt` discriminator (earn program). Lifted verbatim from
 * `scripts/lib/e2e-earn.ts` / `scripts/lib/seed-meteora-pool.ts`
 * (MINT_RWT_DISCRIMINATOR), cross-checked against
 * `contracts/earn/src/instructions/mint_rwt.rs`.
 */
const MINT_RWT_DISCRIMINATOR = Buffer.from([0x62, 0x20, 0x73, 0xde, 0x44, 0x0c, 0xa1, 0xa2]);

function u64Le(amount: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(amount, 0);
  return b;
}

/**
 * Build an `earn::add_to_basket(amount)` instruction.
 *
 * Accounts (order from AddToBasket struct):
 *   0 authority         signer
 *   1 earn_config       writable   (capital counter bumps)
 *   2 rwt_mint          readonly   (supply read for NAV snapshot)
 *   3 authority_source  writable   (authority's USDC ATA — funds source)
 *   4 basket_vault      writable   (EarnConfig-PDA-owned USDC ATA — destination)
 *   5 token_program     readonly
 */
export function buildAddToBasketIx(params: {
  earnProgramId: PublicKey;
  authority: PublicKey;
  earnConfig: PublicKey;
  rwtMint: PublicKey;
  authoritySource: PublicKey;
  basketVault: PublicKey;
  amount: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.earnProgramId,
    keys: [
      { pubkey: params.authority, isSigner: true, isWritable: false },
      { pubkey: params.earnConfig, isSigner: false, isWritable: true },
      { pubkey: params.rwtMint, isSigner: false, isWritable: false },
      { pubkey: params.authoritySource, isSigner: false, isWritable: true },
      { pubkey: params.basketVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([ADD_TO_BASKET_DISCRIMINATOR, u64Le(params.amount)]),
  });
}

/**
 * Build a `staking::deposit_rewards(rwt_amount)` instruction.
 *
 * Accounts (order from DepositRewards struct):
 *   0 depositor          signer     (must == config.reward_depositor)
 *   1 staking_config     writable   (active counter bumps)
 *   2 strwt_mint         readonly   (supply read for rate snapshot)
 *   3 depositor_rwt_ata  writable   (depositor's RWT source ATA)
 *   4 pool_vault         writable   (config-PDA-owned RWT ATA — destination)
 *   5 token_program      readonly
 */
export function buildDepositRewardsIx(params: {
  stakingProgramId: PublicKey;
  depositor: PublicKey;
  stakingConfig: PublicKey;
  strwtMint: PublicKey;
  depositorRwtAta: PublicKey;
  poolVault: PublicKey;
  rwtAmount: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.stakingProgramId,
    keys: [
      { pubkey: params.depositor, isSigner: true, isWritable: false },
      { pubkey: params.stakingConfig, isSigner: false, isWritable: true },
      { pubkey: params.strwtMint, isSigner: false, isWritable: false },
      { pubkey: params.depositorRwtAta, isSigner: false, isWritable: true },
      { pubkey: params.poolVault, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([DEPOSIT_REWARDS_DISCRIMINATOR, u64Le(params.rwtAmount)]),
  });
}

/**
 * Build an `earn::mint_rwt(usdc_amount, min_rwt_out)` instruction.
 *
 * The user (here the keeper's deployer) deposits `usdcAmount` earn-USDC and
 * receives earn-RWT at the current Book NAV, minus a `mint_fee_bps` fee taken in
 * USDC. The program mints the RWT (the EarnConfig PDA is the rwt_mint authority,
 * which is exactly why the keeper can't raw-mint RWT itself — it must go through
 * this user instruction). `minRwtOut` is the slippage floor (the handler rejects
 * 0 as ZeroSlippage, so callers pass >= 1).
 *
 * Accounts (order from contracts/earn/src/instructions/mint_rwt.rs MintRwt struct):
 *   0 user                signer
 *   1 earn_config         writable
 *   2 rwt_mint            writable   (supply grows)
 *   3 user_usdc           writable   (USDC source: body + fee)
 *   4 user_rwt            writable   (RWT destination)
 *   5 basket_vault        writable   (USDC body destination — NAV backing)
 *   6 dao_fee_destination writable   (USDC fee destination)
 *   7 token_program       readonly
 */
export function buildMintRwtIx(params: {
  earnProgramId: PublicKey;
  user: PublicKey;
  earnConfig: PublicKey;
  rwtMint: PublicKey;
  userUsdc: PublicKey;
  userRwt: PublicKey;
  basketVault: PublicKey;
  daoFeeDestination: PublicKey;
  usdcAmount: bigint;
  minRwtOut: bigint;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: params.earnProgramId,
    keys: [
      { pubkey: params.user, isSigner: true, isWritable: false },
      { pubkey: params.earnConfig, isSigner: false, isWritable: true },
      { pubkey: params.rwtMint, isSigner: false, isWritable: true },
      { pubkey: params.userUsdc, isSigner: false, isWritable: true },
      { pubkey: params.userRwt, isSigner: false, isWritable: true },
      { pubkey: params.basketVault, isSigner: false, isWritable: true },
      { pubkey: params.daoFeeDestination, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      MINT_RWT_DISCRIMINATOR,
      u64Le(params.usdcAmount),
      u64Le(params.minRwtOut),
    ]),
  });
}
