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
    },
  };
};
