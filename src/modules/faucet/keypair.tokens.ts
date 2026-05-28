/**
 * DI tokens for the faucet keypair providers.
 *
 * Kept in a dedicated file so both `faucet.module.ts` (provider
 * registration) and `faucet.service.ts` (consumer injection) can
 * import them without creating a circular import — the module file
 * already imports the service to register it, and the service can't
 * loop-back to the module.
 */
export const FAUCET_AUTHORITY_KEYPAIR = Symbol('FAUCET_AUTHORITY_KEYPAIR');
export const FAUCET_FUNDER_KEYPAIR = Symbol('FAUCET_FUNDER_KEYPAIR');

/**
 * RWT treasury signer — owns the pre-funded treasury ATA from which the
 * RWT faucet transfers drips. Distinct from `FAUCET_AUTHORITY_KEYPAIR`
 * because the RWT mint authority lives on-chain in the RWT engine PDA;
 * the faucet does NOT have mint authority and must use SPL Transfer
 * from a treasury ATA instead of MintTo.
 *
 * Returns `null` outside devnet/localnet so an internal caller can never
 * accidentally drain a real treasury ATA.
 */
export const FAUCET_RWT_TREASURY_KEYPAIR = Symbol('FAUCET_RWT_TREASURY_KEYPAIR');
