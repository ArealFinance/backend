import type { ConfigService } from '@nestjs/config';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR } from './rpc-proxy.constants.js';
import { RpcProxyService } from './rpc-proxy.service.js';

const UPSTREAM_URL = 'https://rpc.example.invalid/with-secret-key';

/**
 * Minimal ConfigService stub returning the proxy config values. Cache is OFF
 * by default so the forwarding tests assert raw upstream behaviour; the cache
 * describe block enables it explicitly.
 */
function makeConfig(overrides: Record<string, unknown> = {}): ConfigService {
  const values: Record<string, unknown> = {
    'solana.rpcUrl': UPSTREAM_URL,
    'rpcProxy.upstreamTimeoutMs': 15_000,
    'rpcProxy.cacheEnabled': false,
    'rpcProxy.cacheTtlMs': 2_000,
    ...overrides,
  };
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

/** Build a valid JSON-RPC request object. */
function rpc(method: string, id: number | string = 1): unknown {
  return { jsonrpc: '2.0', id, method, params: [] };
}

describe('RpcProxyService', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('throws when solana.rpcUrl is missing', () => {
      expect(() => new RpcProxyService(makeConfig({ 'solana.rpcUrl': undefined }))).toThrow(
        /solana.rpcUrl is required/,
      );
    });
  });

  describe('validateRpcRequest', () => {
    let service: RpcProxyService;
    beforeEach(() => {
      service = new RpcProxyService(makeConfig());
    });

    it('accepts a single allowed method', () => {
      expect(service.validateRpcRequest(rpc('getBalance'))).toEqual({ ok: true });
    });

    it('rejects a disallowed method with METHOD_NOT_ALLOWED', () => {
      const result = service.validateRpcRequest(rpc('getProgramAccounts'));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const err = result.error as { error: { code: number; message: string } };
        expect(err.error.code).toBe(RPC_ERROR.METHOD_NOT_ALLOWED);
        expect(err.error.message).toContain('getProgramAccounts');
      }
    });

    it('rejects a non-object body', () => {
      expect(service.validateRpcRequest('nope').ok).toBe(false);
      expect(service.validateRpcRequest(42).ok).toBe(false);
      expect(service.validateRpcRequest(null).ok).toBe(false);
    });

    it('rejects an object with no method', () => {
      const result = service.validateRpcRequest({ jsonrpc: '2.0', id: 1 });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const err = result.error as { error: { code: number } };
        expect(err.error.code).toBe(RPC_ERROR.INVALID_REQUEST);
      }
    });

    it('accepts a batch where every method is allowed', () => {
      const batch = [rpc('getBalance', 1), rpc('getSlot', 2)];
      expect(service.validateRpcRequest(batch)).toEqual({ ok: true });
    });

    it('rejects a batch if any element names a disallowed method', () => {
      const batch = [rpc('getBalance', 1), rpc('getProgramAccounts', 2), rpc('getSlot', 3)];
      const result = service.validateRpcRequest(batch);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const err = result.error as { error: { code: number; message: string } };
        expect(err.error.code).toBe(RPC_ERROR.METHOD_NOT_ALLOWED);
        expect(err.error.message).toContain('getProgramAccounts');
      }
    });

    it('rejects an empty batch', () => {
      expect(service.validateRpcRequest([]).ok).toBe(false);
    });

    it('rejects a batch over the size cap', () => {
      const big = Array.from({ length: 51 }, (_, i) => rpc('getBalance', i));
      const result = service.validateRpcRequest(big);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const err = result.error as { error: { message: string } };
        expect(err.error.message).toContain('batch too large');
      }
    });
  });

  describe('handle (forwarding)', () => {
    let service: RpcProxyService;
    beforeEach(() => {
      service = new RpcProxyService(makeConfig());
    });

    it('forwards an allowed method to the upstream and returns 200 + body', async () => {
      const upstreamBody = { jsonrpc: '2.0', id: 1, result: { value: 5_000_000_000 } };
      fetchMock.mockResolvedValue({
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify(upstreamBody)),
      });

      const result = await service.handle(rpc('getBalance'));

      expect(result.status).toBe(200);
      expect(result.body).toEqual(upstreamBody);
      // Forwarded to the configured upstream, not a caller-chosen URL.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe(UPSTREAM_URL);
    });

    it('does not call upstream for a disallowed method, returns 400', async () => {
      const result = await service.handle(rpc('getProgramAccounts'));
      expect(result.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
      const body = result.body as { error: { code: number } };
      expect(body.error.code).toBe(RPC_ERROR.METHOD_NOT_ALLOWED);
    });

    it('does not call upstream for a malformed body, returns 400', async () => {
      const result = await service.handle('garbage');
      expect(result.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not call upstream when a batch contains a bad method', async () => {
      const result = await service.handle([rpc('getBalance', 1), rpc('getProgramAccounts', 2)]);
      expect(result.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 502 when upstream returns non-JSON', async () => {
      fetchMock.mockResolvedValue({
        status: 502,
        text: vi.fn().mockResolvedValue('<html>Bad Gateway</html>'),
      });
      const result = await service.handle(rpc('getSlot'));
      expect(result.status).toBe(502);
      const body = result.body as { error: { code: number } };
      expect(body.error.code).toBe(RPC_ERROR.UPSTREAM_ERROR);
    });

    it('returns 504 when the upstream fetch aborts (timeout)', async () => {
      const abortErr = new Error('aborted');
      abortErr.name = 'AbortError';
      fetchMock.mockRejectedValue(abortErr);
      const result = await service.handle(rpc('getSlot'));
      expect(result.status).toBe(504);
      const body = result.body as { error: { message: string } };
      expect(body.error.message).toContain('timed out');
    });

    it('returns 502 on a generic upstream failure', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await service.handle(rpc('getSlot'));
      expect(result.status).toBe(502);
    });

    it('never leaks the upstream URL in the response body', async () => {
      fetchMock.mockRejectedValue(new Error('ECONNREFUSED at ' + UPSTREAM_URL));
      const result = await service.handle(rpc('getSlot'));
      expect(JSON.stringify(result.body)).not.toContain('secret-key');
    });
  });

  describe('logger never leaks the upstream URL / key', () => {
    // The at-risk sink is the LOGGER, not the response body: undici/driver
    // errors can embed the request URL (which carries the Helius key). Spy on
    // every Logger level and assert the secret never appears in any call,
    // across all error paths.
    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    let errorSpy: ReturnType<typeof vi.spyOn>;
    let service: RpcProxyService;

    beforeEach(async () => {
      const { Logger } = await import('@nestjs/common');
      logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      errorSpy = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      service = new RpcProxyService(makeConfig());
    });

    /** Concatenate every argument of every spied log call into one string. */
    function allLogText(): string {
      const calls = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls];
      return calls.map((args) => args.map((a) => String(a)).join(' ')).join('\n');
    }

    it('does not log the secret on a generic upstream throw carrying the URL', async () => {
      fetchMock.mockRejectedValue(new Error('connect ECONNREFUSED ' + UPSTREAM_URL));
      await service.handle(rpc('getSlot'));
      const text = allLogText();
      expect(text).not.toContain('secret-key');
      expect(text).not.toContain(UPSTREAM_URL);
    });

    it('does not log the secret on a timeout (AbortError)', async () => {
      const abortErr = new Error('The operation was aborted ' + UPSTREAM_URL);
      abortErr.name = 'AbortError';
      fetchMock.mockRejectedValue(abortErr);
      await service.handle(rpc('getSlot'));
      expect(allLogText()).not.toContain('secret-key');
    });

    it('does not log the secret on an upstream 5xx', async () => {
      fetchMock.mockResolvedValue({
        status: 503,
        text: vi.fn().mockResolvedValue(JSON.stringify({ jsonrpc: '2.0', id: 1, error: {} })),
      });
      await service.handle(rpc('getSlot'));
      expect(allLogText()).not.toContain('secret-key');
    });

    it('does not log the secret on a non-JSON upstream response', async () => {
      fetchMock.mockResolvedValue({
        status: 502,
        text: vi.fn().mockResolvedValue('<html>' + UPSTREAM_URL + '</html>'),
      });
      await service.handle(rpc('getSlot'));
      expect(allLogText()).not.toContain('secret-key');
    });
  });

  describe('hot-read cache', () => {
    function makeCachingService(): RpcProxyService {
      return new RpcProxyService(makeConfig({ 'rpcProxy.cacheEnabled': true }));
    }

    it('serves a second getLatestBlockhash from cache without a second upstream call', async () => {
      const upstream = {
        jsonrpc: '2.0',
        id: 1,
        result: { context: { slot: 100 }, value: { blockhash: 'abc', lastValidBlockHeight: 200 } },
      };
      fetchMock.mockResolvedValue({
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify(upstream)),
      });
      const service = makeCachingService();

      const first = await service.handle(rpc('getLatestBlockhash', 1));
      const second = await service.handle(rpc('getLatestBlockhash', 2));

      expect(fetchMock).toHaveBeenCalledTimes(1); // second served from cache
      expect((first.body as { result: unknown }).result).toEqual(upstream.result);
      // Cached body carries the SECOND caller's id, with the same result.
      expect(second.body).toEqual({ jsonrpc: '2.0', id: 2, result: upstream.result });
    });

    it('does not cache an error response', async () => {
      fetchMock.mockResolvedValue({
        status: 200,
        text: vi
          .fn()
          .mockResolvedValue(
            JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'x' } }),
          ),
      });
      const service = makeCachingService();
      await service.handle(rpc('getLatestBlockhash', 1));
      await service.handle(rpc('getLatestBlockhash', 2));
      // Error not cached → upstream hit twice.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not cache a non-cacheable method (getBalance)', async () => {
      fetchMock.mockResolvedValue({
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 5 })),
      });
      const service = makeCachingService();
      await service.handle(rpc('getBalance', 1));
      await service.handle(rpc('getBalance', 2));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('keys cache by params so different commitments do not collide', async () => {
      fetchMock.mockResolvedValue({
        status: 200,
        text: vi
          .fn()
          .mockResolvedValue(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { v: 1 } })),
      });
      const service = makeCachingService();
      await service.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'getLatestBlockhash',
        params: [{ commitment: 'finalized' }],
      });
      await service.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'getLatestBlockhash',
        params: [{ commitment: 'processed' }],
      });
      // Different params → separate keys → two upstream hits.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('bypasses the cache entirely when disabled', async () => {
      fetchMock.mockResolvedValue({
        status: 200,
        text: vi.fn().mockResolvedValue(JSON.stringify({ jsonrpc: '2.0', id: 1, result: 1 })),
      });
      // makeConfig defaults cacheEnabled=false.
      const service = new RpcProxyService(makeConfig());
      await service.handle(rpc('getLatestBlockhash', 1));
      await service.handle(rpc('getLatestBlockhash', 2));
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
