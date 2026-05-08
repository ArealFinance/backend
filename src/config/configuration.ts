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
      secret: process.env.JWT_SECRET ?? '',
      refreshSecret: process.env.JWT_REFRESH_SECRET ?? '',
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
    },

    metrics: {
      enabled: asBool(process.env.METRICS_ENABLED, true),
    },
  };
};
