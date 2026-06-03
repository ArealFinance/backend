// DEVNET-ONLY — must never run on mainnet.
//
// Shared, fail-closed gate predicates for the devnet yield keeper. Centralised
// here so the boot-time pin (earn-keeper.module.ts) and the runtime re-check
// (earn-keeper.service.ts) apply IDENTICAL logic — a single source of truth for
// "is this a devnet target?". Tightened per the security review:
//
//   - RPC gate (Gate 4): host-anchored allowlist. The previous substring match
//     (`/devnet|localhost/.test(rpc)`) accepted ANY url merely CONTAINING the
//     substring, so e.g. `https://mainnet.example.com/devnet-path` slipped
//     through. We now parse the URL and match the EXACT hostname against an
//     explicit allowlist (no path/query/userinfo influence).
//
//   - Cluster gate (Gate 1/runtime): fail-closed. Anything not explicitly a
//     known devnet/local cluster is treated as non-runnable. A missing or
//     typo'd SOLANA_CLUSTER must NEVER be coerced to 'devnet'.

import type { SolanaCluster } from '../../config/configuration.js';

/**
 * Exact devnet RPC hostnames. A coincidental substring match (e.g. a mainnet
 * host with a `/devnet` path) must NOT pass — we compare the parsed hostname,
 * not the raw string.
 */
const ALLOWED_RPC_HOSTS = new Set<string>([
  'api.devnet.solana.com',
  // Helius devnet APEX host. The live beget devnet RPC is
  // `https://devnet.helius-rpc.com/?api-key=…`, whose hostname is the apex
  // `devnet.helius-rpc.com` — it has NO subdomain label, so it does NOT match
  // the `.devnet.helius-rpc.com` suffix below (that needs a leading label like
  // `my-key.devnet.helius-rpc.com`). It must be allowlisted explicitly. This is
  // still tight: `mainnet.helius-rpc.com`, `rpc.helius.xyz`, and
  // `devnet.helius-rpc.com.attacker.tld` are all distinct hostnames and remain
  // rejected.
  'devnet.helius-rpc.com',
  'localhost',
  '127.0.0.1',
  '::1',
]);

/**
 * Hostname SUFFIXES that are allowed (matched as `.suffix`, so the boundary is a
 * real DNS label — `evil-devnet.helius-rpc.com` matches, but
 * `devnet.helius-rpc.com.attacker.tld` does NOT because the suffix is anchored
 * to the end of the hostname). The apex `devnet.helius-rpc.com` is covered by
 * the exact-host allowlist above (a suffix needs a leading label).
 */
const ALLOWED_RPC_HOST_SUFFIXES = ['.devnet.helius-rpc.com'] as const;

/**
 * Gate 4 — host-anchored RPC allowlist.
 *
 * Returns true ONLY if the URL parses and its hostname is an exact allowlisted
 * devnet host or ends with an allowlisted devnet suffix. Unparseable URLs,
 * mainnet hosts, and coincidental-substring URLs all return false (fail-closed).
 */
export function isAllowedDevnetRpc(rpcUrl: string | undefined | null): boolean {
  if (!rpcUrl) return false;
  let host: string;
  try {
    host = new URL(rpcUrl).hostname.toLowerCase();
  } catch {
    // Unparseable URL → reject. Never fall back to a substring check.
    return false;
  }
  if (host.length === 0) return false;
  if (ALLOWED_RPC_HOSTS.has(host)) return true;
  return ALLOWED_RPC_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Gate 1 / runtime cluster gate — fail-closed cluster classification.
 *
 * Returns true ONLY for clusters where the keeper is permitted to act
 * (`devnet`, plus `localnet`/`localhost` for local dev). Anything else —
 * `mainnet`, `testnet`, unset, empty, or a typo — returns false. The keeper is
 * inert by default; only an explicit, recognised local/devnet cluster enables
 * it.
 */
export function isRunnableCluster(cluster: SolanaCluster | string | undefined | null): boolean {
  return cluster === 'devnet' || cluster === 'localnet' || cluster === 'localhost';
}

/** True ONLY for the `devnet` cluster (the keeper's runtime-active target). */
export function isDevnetCluster(cluster: SolanaCluster | string | undefined | null): boolean {
  return cluster === 'devnet';
}
