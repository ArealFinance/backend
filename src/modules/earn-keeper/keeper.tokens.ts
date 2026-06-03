/**
 * DI token for the devnet yield-keeper signer keypair.
 *
 * Resolves to the devnet deployer (`8ddRxwGn…`), which is BOTH the earn
 * authority (signs `add_to_basket`) AND the staking `reward_depositor` (signs
 * `deposit_rewards`) AND the earn-USDC mint authority (signs `MintTo`). Kept as
 * a DISTINCT token from the faucet keypairs so the keeper's boot-time pin and
 * cluster gate stay independent of the faucet — a future role split (e.g. a
 * dedicated keeper signer) moves only this token.
 *
 * The provider returns `null` outside devnet/localnet so an internal caller can
 * never sign keeper instructions against a real cluster. Combined with the
 * other four gates (see `earn-keeper.module.ts`), a null here makes the cron a
 * pure no-op on any non-devnet deployment.
 */
export const KEEPER_AUTHORITY_KEYPAIR = Symbol('KEEPER_AUTHORITY_KEYPAIR');
