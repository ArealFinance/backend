import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { JsonRpcRequest } from './dto/json-rpc.dto.js';
import {
  ALLOWED_RPC_METHODS,
  CACHEABLE_RPC_METHODS,
  MAX_BATCH_SIZE,
  RPC_ERROR,
} from './rpc-proxy.constants.js';

/**
 * Result of forwarding: the upstream JSON body + the HTTP status the proxy
 * should reply with. We always reply 200 for a *well-formed* JSON-RPC request
 * (errors are carried inside the JSON-RPC `error` member, per spec); transport
 * failures surface as 502/504 with a JSON-RPC error body so a wallet SDK can
 * still parse it.
 */
export interface ProxyResult {
  status: number;
  body: unknown;
}

/** A JSON-RPC error envelope for a given id. */
function rpcError(id: JsonRpcRequest['id'], code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** One cached upstream `result` with its expiry. */
interface CacheEntry {
  /** The upstream `result` member (NOT the full envelope — `id` is per-caller). */
  result: unknown;
  /** Epoch ms after which the entry is stale. */
  expiresAt: number;
}

/**
 * Deterministic JSON for cache keys: object keys are sorted so
 * `{a:1,b:2}` and `{b:2,a:1}` map to the SAME cache entry. Used only on
 * JSON-RPC `params` (small, JSON-safe), so the recursion is bounded.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Public JSON-RPC proxy core.
 *
 * Responsibilities:
 *   1. Structurally validate the incoming body (single object or batch array).
 *   2. Enforce the method allow-list on EVERY element (a batch is rejected
 *      whole if any element names a disallowed method).
 *   3. Forward the original body verbatim to the server-side RPC with a
 *      timeout, returning the upstream response.
 *
 * Security invariants:
 *   - The upstream URL comes from ConfigService (`solana.rpcUrl`) — the caller
 *     can NEVER influence the target (no open proxy).
 *   - The upstream URL / Helius key is NEVER logged. Errors log the method and
 *     a generic message only.
 */
@Injectable()
export class RpcProxyService {
  private readonly logger = new Logger(RpcProxyService.name);
  private readonly upstreamUrl: string;
  private readonly timeoutMs: number;
  private readonly cacheEnabled: boolean;
  private readonly cacheTtlMs: number;
  /**
   * In-memory hot-read cache for `getLatestBlockhash` / `getSlot` /
   * `getEpochInfo`. Tiny (a handful of keys, TTL ~2s), so a plain Map with
   * lazy expiry is sufficient — no eviction loop needed. Per-replica, like the
   * throttler; acceptable because the values are intentionally short-lived and
   * a slightly-stale blockhash is safe (web3.js refreshes on BlockhashNotFound).
   */
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly config: ConfigService) {
    const url = this.config.get<string>('solana.rpcUrl');
    if (!url) {
      throw new Error('solana.rpcUrl is required for the RPC proxy — set RPC_URL_<CLUSTER> in env');
    }
    this.upstreamUrl = url;
    this.timeoutMs = this.config.get<number>('rpcProxy.upstreamTimeoutMs') ?? 15_000;
    this.cacheEnabled = this.config.get<boolean>('rpcProxy.cacheEnabled') ?? true;
    this.cacheTtlMs = this.config.get<number>('rpcProxy.cacheTtlMs') ?? 2_000;
  }

  /**
   * Validate + forward. `body` is the raw, parsed request body (object or
   * array). Returns a `ProxyResult`; never throws for an invalid request —
   * an invalid request yields a JSON-RPC error body with HTTP 200/400 so the
   * caller's RPC client can parse it uniformly.
   */
  async handle(body: unknown): Promise<ProxyResult> {
    const validation = this.validateRpcRequest(body);
    if (!validation.ok) {
      // Malformed envelope or disallowed method → JSON-RPC error. We use HTTP
      // 400 so abuse is visible in access logs / metrics, while the body stays
      // a parseable JSON-RPC error for well-behaved clients.
      return { status: 400, body: validation.error };
    }

    // Hot-read cache: only single (non-batch) cacheable methods. A batch is
    // forwarded whole — mixing cached + live sub-responses isn't worth the
    // complexity for the volume we see.
    const cacheKey = this.cacheKeyFor(body);
    if (cacheKey) {
      const hit = this.readCache(cacheKey);
      if (hit !== undefined) {
        const id = (body as JsonRpcRequest).id ?? null;
        // Re-stamp the CALLER's id on the cached result so their RPC client
        // matches the response to its request.
        return { status: 200, body: { jsonrpc: '2.0', id, result: hit } };
      }
    }

    return this.forward(body, cacheKey);
  }

  /**
   * Cache key for a request, or `null` if it isn't a cacheable single request.
   * Keyed on method + params so different commitments / args don't collide.
   */
  private cacheKeyFor(body: unknown): string | null {
    if (!this.cacheEnabled || Array.isArray(body) || typeof body !== 'object' || body === null) {
      return null;
    }
    const req = body as Partial<JsonRpcRequest>;
    if (typeof req.method !== 'string' || !CACHEABLE_RPC_METHODS.has(req.method)) {
      return null;
    }
    return `${req.method}:${stableStringify(req.params ?? null)}`;
  }

  /** Return a fresh cached result, or `undefined` on miss/expiry. */
  private readCache(key: string): unknown {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  /**
   * Structural validation of a JSON-RPC payload.
   *
   * Accepts either a single request object or a non-empty batch array. Returns
   * `{ ok: true }` when every element is a well-formed JSON-RPC request whose
   * method is in the allow-list; otherwise `{ ok: false, error }` where
   * `error` is a ready-to-return JSON-RPC error envelope.
   */
  validateRpcRequest(body: unknown): { ok: true } | { ok: false; error: unknown } {
    // Batch.
    if (Array.isArray(body)) {
      if (body.length === 0) {
        return {
          ok: false,
          error: rpcError(null, RPC_ERROR.INVALID_REQUEST, 'Invalid Request: empty batch'),
        };
      }
      if (body.length > MAX_BATCH_SIZE) {
        return {
          ok: false,
          error: rpcError(
            null,
            RPC_ERROR.INVALID_REQUEST,
            `Invalid Request: batch too large (max ${MAX_BATCH_SIZE})`,
          ),
        };
      }
      for (const element of body) {
        const single = this.validateSingle(element);
        if (!single.ok) return single;
      }
      return { ok: true };
    }

    // Single.
    return this.validateSingle(body);
  }

  /** Validate one JSON-RPC request element. */
  private validateSingle(element: unknown): { ok: true } | { ok: false; error: unknown } {
    if (typeof element !== 'object' || element === null) {
      return {
        ok: false,
        error: rpcError(null, RPC_ERROR.INVALID_REQUEST, 'Invalid Request: not an object'),
      };
    }
    const req = element as Partial<JsonRpcRequest>;
    const id = (req.id ?? null) as JsonRpcRequest['id'];

    if (typeof req.method !== 'string' || req.method.length === 0) {
      return {
        ok: false,
        error: rpcError(id, RPC_ERROR.INVALID_REQUEST, 'Invalid Request: missing method'),
      };
    }

    if (!ALLOWED_RPC_METHODS.has(req.method)) {
      // Do NOT echo the rejected method verbatim into logs at a high level — a
      // single warn line with the method name is fine (it's not sensitive),
      // but never the upstream URL.
      this.logger.warn(`rejected disallowed method=${req.method}`);
      return {
        ok: false,
        error: rpcError(id, RPC_ERROR.METHOD_NOT_ALLOWED, `Method not allowed: ${req.method}`),
      };
    }

    return { ok: true };
  }

  /**
   * Forward the (already validated) body to the upstream RPC. Uses native
   * fetch with an AbortController timeout so a hung upstream can't pile up.
   *
   * @param cacheKey when non-null, a successful single-result response is
   *                 stored under this key for `cacheTtlMs`.
   */
  private async forward(body: unknown, cacheKey: string | null = null): Promise<ProxyResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const t0 = Date.now();
    try {
      const res = await fetch(this.upstreamUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      // Read as text first so a non-JSON upstream error page doesn't throw an
      // unhelpful parse error — wrap it in a JSON-RPC envelope instead.
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        this.logger.error(`upstream returned non-JSON status=${res.status}`);
        return {
          status: 502,
          body: rpcError(null, RPC_ERROR.UPSTREAM_ERROR, 'Upstream returned a non-JSON response'),
        };
      }

      const dt = Date.now() - t0;
      // Mirror upstream HTTP status when it's an error class (429/5xx) so the
      // client backs off; otherwise reply 200 (JSON-RPC errors ride in body).
      const status = res.status >= 400 ? res.status : 200;
      this.logger.log(`forwarded ${this.describe(body)} status=${res.status} dt=${dt}ms`);

      // Populate the hot-read cache only on a clean success: HTTP 2xx AND a
      // JSON-RPC `result` member present (never cache an `error` response, so a
      // transient upstream error can't be served stale for the TTL window).
      if (cacheKey && status === 200) {
        const result = (parsed as { result?: unknown; error?: unknown } | null)?.result;
        const hasError = (parsed as { error?: unknown } | null)?.error !== undefined;
        if (result !== undefined && !hasError) {
          this.cache.set(cacheKey, { result, expiresAt: Date.now() + this.cacheTtlMs });
        }
      }

      return { status, body: parsed };
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      // NEVER log the raw error message — undici/driver errors can embed the
      // request URL (which carries the Helius key). Log only the error class
      // and (if present) its system error code, both of which are safe.
      const name = e instanceof Error ? e.name : 'Unknown';
      const code = (e as { code?: unknown })?.code;
      this.logger.error(
        `upstream ${aborted ? 'timeout' : 'failure'} (${name}${code ? ` ${String(code)}` : ''})`,
      );
      return {
        status: aborted ? 504 : 502,
        body: rpcError(
          null,
          RPC_ERROR.UPSTREAM_ERROR,
          aborted ? 'Upstream RPC timed out' : 'Upstream RPC request failed',
        ),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Compact, non-sensitive description of a request for logs (method only). */
  private describe(body: unknown): string {
    if (Array.isArray(body)) {
      return `batch(${body.length})`;
    }
    const method = (body as { method?: unknown })?.method;
    return typeof method === 'string' ? method : 'unknown';
  }
}
