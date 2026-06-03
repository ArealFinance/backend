/**
 * Centralised env-driven configuration.
 *
 * Loaded by `ConfigModule.forRoot({ load: [configuration] })` and consumed via
 * `ConfigService.get('jwt.secret')` etc. — never read `process.env` directly
 * outside this file. This keeps env precedence rules in one place and makes
 * it trivial to mock config in tests (just register a stub provider).
 */

export type SolanaCluster = 'mainnet' | 'devnet' | 'localnet';

const DEFAULT_PORT = 3010;
const DEFAULT_BACKFILL_BLOCKS = 216_000; // ~1 day at 400ms slots
const DEFAULT_RECONCILE_INTERVAL_SECS = 300; // 5 min
const DEFAULT_MAX_RECONCILE_SIGNATURES = 50_000;
// Hard ceiling on a single per-program backfill sweep. Without a bound a
// chatty program + a wide BACKFILL_BLOCKS can OOM the listener while it
// holds the in-flight signatures + bull payloads. ReconcileService will
// continue to close any residual gap on its 5-min cron after the cap fires.
const DEFAULT_MAX_BACKFILL_SIGNATURES = 50_000;

function asInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

export default () => {
  const cluster = (process.env.SOLANA_CLUSTER ?? 'devnet') as SolanaCluster;

  // Fail-fast (R-12.3.1-8): an empty JWT_SECRET / JWT_REFRESH_SECRET would let
  // the process boot, then `JwtStrategy.validate` / refresh-token HMAC would
  // throw at the first request. Surface the misconfig at boot instead so a
  // bad deploy is rejected before traffic ramps. The check lives INSIDE the
  // factory (not at module load) so dev-tools that import this file for
  // type-only purposes don't accidentally throw at import time.
  if (!process.env.JWT_SECRET) {
    throw new Error(
      'JWT_SECRET environment variable is required — refusing to boot without it. ' +
        'Set it in .env / deployment secrets.',
    );
  }
  if (!process.env.JWT_REFRESH_SECRET) {
    throw new Error(
      'JWT_REFRESH_SECRET environment variable is required — the refresh-token HMAC ' +
        'depends on it. Set it in .env / deployment secrets.',
    );
  }

  return {
    port: asInt(process.env.PORT, DEFAULT_PORT),
    environment: process.env.NODE_ENV ?? 'development',

    database: {
      url: process.env.DATABASE_URL ?? '',
      schema: 'areal',
      synchronize: false, // Always false — migrations only.
      logging: asBool(process.env.TYPEORM_LOGGING, false),
    },

    redis: {
      url: process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0',
    },

    jwt: {
      secret: process.env.JWT_SECRET,
      refreshSecret: process.env.JWT_REFRESH_SECRET,
      expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
      refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d',
    },

    solana: {
      cluster,
      rpcUrl:
        cluster === 'mainnet'
          ? (process.env.RPC_URL_MAINNET ?? '')
          : cluster === 'devnet'
            ? (process.env.RPC_URL_DEVNET ?? 'https://api.devnet.solana.com')
            : (process.env.RPC_URL_LOCALNET ?? 'http://127.0.0.1:8899'),
      wsUrl:
        cluster === 'mainnet'
          ? process.env.RPC_WS_MAINNET
          : cluster === 'devnet'
            ? process.env.RPC_WS_DEVNET
            : process.env.RPC_WS_LOCALNET,
    },

    indexer: {
      backfillBlocks: asInt(process.env.BACKFILL_BLOCKS, DEFAULT_BACKFILL_BLOCKS),
      reconcileIntervalSecs: asInt(
        process.env.RECONCILE_INTERVAL_SECS,
        DEFAULT_RECONCILE_INTERVAL_SECS,
      ),
      maxReconcileSignatures: asInt(
        process.env.MAX_RECONCILE_SIGNATURES,
        DEFAULT_MAX_RECONCILE_SIGNATURES,
      ),
      maxBackfillSignatures: asInt(
        process.env.MAX_BACKFILL_SIGNATURES,
        DEFAULT_MAX_BACKFILL_SIGNATURES,
      ),
    },

    metrics: {
      enabled: asBool(process.env.METRICS_ENABLED, true),
    },

    // Localnet-only test-USDC faucet. The actual constants
    // (mint pubkey, authority pubkey, decimals, drip caps) live in
    // `modules/faucet/faucet.constants.ts` so they stay close to the
    // SPL helpers that consume them — this block only carries the
    // base64 keypair env passthroughs.
    faucet: {
      usdcAuthorityKeypairB64: process.env.FAUCET_USDC_AUTHORITY_KEYPAIR_B64,
      solFunderKeypairB64: process.env.FAUCET_SOL_FUNDER_KEYPAIR_B64,
      // Expected mint-authority pubkey — the boot-time safety pin. On a
      // test-validator reset the deployer (and thus the faucet authority)
      // rotates; set this to the new deployer pubkey so the boot check
      // tracks it without a code change. Falls back to
      // DEFAULT_EXPECTED_AUTHORITY in faucet.constants.ts when unset.
      usdcAuthorityPubkey: process.env.FAUCET_USDC_AUTHORITY,
      // RWT faucet (devnet) — base64 of the deployer keypair that owns the
      // pre-funded RWT treasury ATA. Same anti-drift pattern as the USDC
      // authority pin: the expected pubkey is sourced from
      // FAUCET_RWT_TREASURY, falling back to
      // DEFAULT_EXPECTED_RWT_TREASURY in faucet.constants.ts.
      rwtTreasuryKeypairB64: process.env.FAUCET_RWT_TREASURY_KEYPAIR_B64,
      rwtTreasuryPubkey: process.env.FAUCET_RWT_TREASURY,
      // Earn-USDC faucet (devnet/localnet) — base64 of the earn deployer
      // keypair that holds the mint authority of the earn USDC mint (MintTo).
      // Same anti-drift pattern as the USDC authority pin: the expected pubkey
      // is sourced from FAUCET_EARN_USDC_AUTHORITY, falling back to
      // DEFAULT_EXPECTED_EARN_USDC_AUTHORITY in faucet.constants.ts. The earn
      // mint itself is pinned as EARN_USDC_MINT_PUBKEY there, overridable via
      // FAUCET_EARN_USDC_MINT (a SEPARATE mint from the main-app USDC).
      earnUsdcAuthorityKeypairB64: process.env.FAUCET_EARN_USDC_AUTHORITY_KEYPAIR_B64,
      earnUsdcAuthorityPubkey: process.env.FAUCET_EARN_USDC_AUTHORITY,
      earnUsdcMint: process.env.FAUCET_EARN_USDC_MINT,
    },

    // Earn / staking program IDs. Pinned in modules/earn-snapshot/earn-onchain.ts
    // (the SDK's built dist predates these programs), overridable here so a
    // redeploy propagates via env. Consumed by both the snapshot service and
    // the keeper.
    earn: {
      programId: process.env.EARN_PROGRAM_ID,
      stakingProgramId: process.env.STAKING_PROGRAM_ID,
    },

    // Devnet-ONLY yield keeper. A simulation of the real off-chain income
    // distributor: a 1-min cron that deposits small rewards on-chain so the
    // stRWT rate / Book NAV genuinely move on devnet. Inert unless FIVE
    // fail-closed gates all pass (see modules/earn-keeper/earn-keeper.module.ts);
    // can NEVER run on mainnet. The signing keypair is the devnet deployer
    // (= earn authority + staking reward_depositor + earn-USDC mint authority).
    earnKeeper: {
      // Master enable flag — default false. Both this AND cluster==devnet are
      // required for the cron to do anything; either off → no-op.
      enabled: asBool(process.env.DEVNET_YIELD_KEEPER_ENABLED, false),
      // Target APY in basis points (1200 = 12%/yr). Drives the per-minute
      // reward sizing for both deposit_rewards and add_to_basket.
      apyBps: asInt(process.env.DEVNET_YIELD_KEEPER_APY_BPS, 1200),
      // base64 of the deployer keypair that signs keeper instructions. Reuses
      // the SAME deployer the faucet loads (8ddRxwGn…); falls back to the
      // faucet's RWT-treasury keypair env if the dedicated one is unset, so a
      // single deployer secret in the env serves both paths.
      authorityKeypairB64:
        process.env.DEVNET_YIELD_KEEPER_KEYPAIR_B64 ?? process.env.FAUCET_RWT_TREASURY_KEYPAIR_B64,
      // Expected signer pubkey — boot-time safety pin. Falls back to the
      // faucet's RWT-treasury pubkey env, then the pinned deployer constant.
      authorityPubkey: process.env.DEVNET_YIELD_KEEPER_AUTHORITY ?? process.env.FAUCET_RWT_TREASURY,
    },
  };
};
