/**
 * Centralised env-driven configuration.
 *
 * Loaded by `ConfigModule.forRoot({ load: [configuration] })` and consumed via
 * `ConfigService.get('jwt.secret')` etc. — never read `process.env` directly
 * outside this file. This keeps env precedence rules in one place and makes
 * it trivial to mock config in tests (just register a stub provider).
 */

import {
  DEFAULT_RPC_PROXY_CACHE_TTL_MS,
  DEFAULT_RPC_PROXY_RATE_LIMIT,
  DEFAULT_RPC_PROXY_RATE_TTL_MS,
} from '../modules/rpc-proxy/rpc-proxy.constants.js';

export type SolanaCluster = 'mainnet' | 'devnet' | 'localnet';

/**
 * Normalise the raw `SOLANA_CLUSTER` value to the internal `SolanaCluster`
 * union. The public Solana SDK spells mainnet `mainnet-beta`; the repo's
 * internal convention is `mainnet`. Accept both so a deploy can use either
 * spelling without the `rpcUrl` selection silently falling through to the
 * localnet branch (which would point the proxy at `RPC_URL_LOCALNET`).
 */
function normalizeCluster(raw: string | undefined): SolanaCluster {
  if (raw === 'mainnet' || raw === 'mainnet-beta') return 'mainnet';
  if (raw === 'localnet') return 'localnet';
  return 'devnet';
}

const DEFAULT_PORT = 3010;
const DEFAULT_BACKFILL_BLOCKS = 216_000; // ~1 day at 400ms slots
const DEFAULT_RECONCILE_INTERVAL_SECS = 300; // 5 min
const DEFAULT_MAX_RECONCILE_SIGNATURES = 50_000;
// Hard ceiling on a single per-program backfill sweep. Without a bound a
// chatty program + a wide BACKFILL_BLOCKS can OOM the listener while it
// holds the in-flight signatures + bull payloads. ReconcileService will
// continue to close any residual gap on its 5-min cron after the cap fires.
const DEFAULT_MAX_BACKFILL_SIGNATURES = 50_000;

// -- RPC proxy defaults -------------------------------------------------------
// Per-IP rate limit (DEFAULT_RPC_PROXY_RATE_LIMIT / _RATE_TTL_MS) is defined in
// rpc-proxy.constants.ts and imported above, so the documented default here and
// the controller's static @Throttle decorator can never drift apart.
//
// Body-size cap (bytes). A signed `sendTransaction` is a few KB at most; 100KB
// leaves room for a wide batch while rejecting absurd payloads early.
const DEFAULT_RPC_PROXY_MAX_BODY_BYTES = 100_000;
// Upstream fetch timeout (ms). A hung Helius response must not pile up open
// sockets — abort and surface a JSON-RPC upstream error instead.
const DEFAULT_RPC_PROXY_UPSTREAM_TIMEOUT_MS = 15_000;

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
  const cluster = normalizeCluster(process.env.SOLANA_CLUSTER);

  // True when booting the slim RPC-proxy-only mode (`RPC_PROXY_ONLY=true`): a
  // standalone Solana RPC proxy with no DB / indexer / keeper / auth — only
  // `POST /rpc` + `GET /health`. Read INSIDE the factory (not at module load)
  // so it reflects the env at the moment ConfigModule calls this factory, the
  // same way the JWT check below reads `process.env` live — a module-load
  // capture would freeze whatever value happened to be set when this file was
  // first imported (e.g. by a type-only import or another spec).
  const rpcProxyOnly = process.env.RPC_PROXY_ONLY === 'true';

  // Fail-fast (R-12.3.1-8): an empty JWT_SECRET / JWT_REFRESH_SECRET would let
  // the process boot, then `JwtStrategy.validate` / refresh-token HMAC would
  // throw at the first request. Surface the misconfig at boot instead so a
  // bad deploy is rejected before traffic ramps. The check lives INSIDE the
  // factory (not at module load) so dev-tools that import this file for
  // type-only purposes don't accidentally throw at import time.
  //
  // SKIPPED in RPC-proxy-only mode: that slim boot loads no AuthModule /
  // JwtStrategy / refresh-token path, so a JWT secret is meaningless there.
  // Requiring one would force operators to inject an unused secret into a
  // service that never touches auth. The full-stack boot (RPC_PROXY_ONLY unset)
  // keeps the guard exactly as before.
  if (!rpcProxyOnly) {
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

    // Public JSON-RPC proxy (`POST /rpc`). Forwards a locked-down allow-list of
    // methods to the server-side `solana.rpcUrl` so the web app / Seeker APK
    // never embed a Helius key client-side. All knobs are env-overridable so an
    // operator can tighten the rate limit without a code change.
    rpcProxy: {
      rateLimit: asInt(process.env.RPC_PROXY_RATE_LIMIT, DEFAULT_RPC_PROXY_RATE_LIMIT),
      rateTtlMs: asInt(process.env.RPC_PROXY_RATE_TTL_MS, DEFAULT_RPC_PROXY_RATE_TTL_MS),
      maxBodyBytes: asInt(process.env.RPC_PROXY_MAX_BODY_BYTES, DEFAULT_RPC_PROXY_MAX_BODY_BYTES),
      upstreamTimeoutMs: asInt(
        process.env.RPC_PROXY_UPSTREAM_TIMEOUT_MS,
        DEFAULT_RPC_PROXY_UPSTREAM_TIMEOUT_MS,
      ),
      // Hot-read cache (getLatestBlockhash / getSlot / getEpochInfo). Default ON
      // — these are the highest-frequency calls and a ~2s-stale blockhash is
      // safe (web3.js refreshes on BlockhashNotFound). Disable with
      // RPC_PROXY_CACHE_ENABLED=false if an issue surfaces.
      cacheEnabled: asBool(process.env.RPC_PROXY_CACHE_ENABLED, true),
      cacheTtlMs: asInt(process.env.RPC_PROXY_CACHE_TTL_MS, DEFAULT_RPC_PROXY_CACHE_TTL_MS),
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
      // RWT buffer sizing (replenish design). The per-tick `deposit_rewards`
      // leg draws from the deployer's RWT ATA balance instead of a fresh
      // per-tick mint (a dust mint would hit the contract's $1.00 min_mint
      // floor and revert the whole tick). A SEPARATE replenish tx tops the ATA
      // back up in ≥$1 chunks (mint_rwt) whenever it drops below the floor.
      //
      // `bufferTicks` = how many ticks of reward the buffer targets / replenish
      // floor is sized to (default ~1 day at 1 tick/min = 1440). The replenish
      // mints `bufferTicks × rwtReward` RWT; the floor is `floorTicks ×
      // rwtReward` (replenish triggers when the ATA can't cover that many more
      // ticks). The mint body is always raised to >= the on-chain min_mint
      // floor so a replenish can never under-shoot and revert.
      bufferTicks: asInt(process.env.DEVNET_YIELD_KEEPER_BUFFER_TICKS, 1_440),
      floorTicks: asInt(process.env.DEVNET_YIELD_KEEPER_FLOOR_TICKS, 60),
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
