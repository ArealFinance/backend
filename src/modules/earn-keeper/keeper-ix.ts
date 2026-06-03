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
