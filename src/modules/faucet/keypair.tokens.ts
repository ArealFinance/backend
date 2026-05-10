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
