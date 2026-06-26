/**
 * RPC proxy allow-list + tunables.
 *
 * This endpoint forwards JSON-RPC to our *server-side* Helius RPC so the web
 * app and the Seeker APK never embed a Helius key client-side. Because the
 * proxy spends our paid RPC quota on behalf of anonymous callers, the surface
 * is locked down hard:
 *
 *   - METHOD ALLOW-LIST — only the read/light methods the app actually calls,
 *     plus the two write paths (`sendTransaction`, `simulateTransaction`).
 *     Heavy scans (`getProgramAccounts`), subscription methods, and anything
 *     else are rejected with a JSON-RPC error BEFORE we touch upstream.
 *   - Per-IP rate limit (configured in `configuration.ts`, enforced by the
 *     global ThrottlerGuard + per-route override).
 *   - Body-size cap + upstream timeout (configured, enforced in the service).
 *
 * Keep this list MINIMAL. Adding a method here widens what an anonymous
 * caller can make us pay Helius for — only add a method when a real app flow
 * needs it, and prefer the lightest variant.
 */

/**
 * The exhaustive set of JSON-RPC methods the proxy will forward. Anything not
 * in this set is rejected. Frozen so it cannot be mutated at runtime.
 */
export const ALLOWED_RPC_METHODS: ReadonlySet<string> = new Set([
  // -- account / balance reads ------------------------------------------------
  'getAccountInfo',
  'getBalance',
  'getMultipleAccounts',
  // -- blockhash / fees -------------------------------------------------------
  'getLatestBlockhash',
  'getFeeForMessage',
  'getMinimumBalanceForRentExemption',
  // -- transaction status -----------------------------------------------------
  'getSignatureStatuses',
  // -- SPL token reads --------------------------------------------------------
  'getTokenAccountBalance',
  'getTokenSupply',
  'getTokenAccountsByOwner',
  'getTokenAccountsByDelegate',
  // -- writes (light) ---------------------------------------------------------
  // ⚠️ DOUBLE-SEND CONTRACT: any WRITE method added here MUST also be added to
  // the frontend's `rpc.ts` `NON_IDEMPOTENT_METHODS` set. The frontend uses
  // that set to suppress automatic retry/failover for non-idempotent calls; a
  // write proxied here but missing there could be silently double-sent on a
  // client-side failover (the same signed tx submitted twice).
  'simulateTransaction',
  'sendTransaction',
  // -- cluster info -----------------------------------------------------------
  'getSlot',
  'getEpochInfo',
]);

/**
 * JSON-RPC error codes we return to the caller. We deliberately use codes in
 * the application-defined range (-32000..-32099 is "server error" per the
 * JSON-RPC 2.0 spec) for the allow-list rejection so a wallet SDK surfaces it
 * as a normal RPC error rather than a transport failure.
 */
export const RPC_ERROR = {
  /** Standard JSON-RPC "Invalid Request" — malformed envelope. */
  INVALID_REQUEST: -32600,
  /** Standard JSON-RPC "Method not found" — used for disallowed methods. */
  METHOD_NOT_ALLOWED: -32601,
  /** Standard JSON-RPC "Parse error". */
  PARSE_ERROR: -32700,
  /** Server error range — upstream failure / timeout. */
  UPSTREAM_ERROR: -32000,
} as const;

/**
 * Max number of elements in a single batch request. A batch is forwarded as
 * one upstream call, so an unbounded batch would let one request fan out into
 * thousands of upstream sub-calls. 50 covers the app's widest real batch
 * (multi-account refresh) with headroom.
 */
export const MAX_BATCH_SIZE = 50;

/**
 * Per-IP rate-limit defaults for the proxy. SINGLE SOURCE OF TRUTH: imported by
 * BOTH `configuration.ts` (runtime config) and the controller's static
 * `@Throttle` decorator bridge (which can't read ConfigService at class-eval
 * time). Keeping them here prevents the documented default and the decorator
 * default from silently drifting apart.
 *
 * 90 req/min/IP is the middle of the requested 60–120 band.
 */
export const DEFAULT_RPC_PROXY_RATE_LIMIT = 90; // requests
export const DEFAULT_RPC_PROXY_RATE_TTL_MS = 60_000; // per window (1 min)

/**
 * Hot-read cache defaults. `getLatestBlockhash` (and optionally
 * `getSlot` / `getEpochInfo`) are the highest-frequency calls; a slightly
 * stale blockhash is safe (web3.js refreshes on `BlockhashNotFound`). Caching
 * these for a couple of seconds collapses a burst of identical calls into one
 * upstream hit, the single biggest cost lever on this endpoint.
 */
export const CACHEABLE_RPC_METHODS: ReadonlySet<string> = new Set([
  'getLatestBlockhash',
  'getSlot',
  'getEpochInfo',
]);
export const DEFAULT_RPC_PROXY_CACHE_TTL_MS = 2_000; // 2s
