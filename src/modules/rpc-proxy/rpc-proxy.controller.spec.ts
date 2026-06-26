import type { ConfigService } from '@nestjs/config';
import { PayloadTooLargeException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { RpcProxyController } from './rpc-proxy.controller.js';
import type { ProxyResult, RpcProxyService } from './rpc-proxy.service.js';

function makeConfig(maxBodyBytes = 100_000): ConfigService {
  return {
    get: vi.fn((key: string) => (key === 'rpcProxy.maxBodyBytes' ? maxBodyBytes : undefined)),
  } as unknown as ConfigService;
}

function makeReq(contentLength: number): Request {
  return {
    headers: { 'content-length': String(contentLength) },
  } as unknown as Request;
}

/** Express Response stub capturing the status + json body. */
function makeRes(): Response & { _status?: number; _body?: unknown } {
  const res = {
    status: vi.fn(function (this: Response & { _status?: number }, code: number) {
      this._status = code;
      return this;
    }),
    json: vi.fn(function (this: Response & { _body?: unknown }, body: unknown) {
      this._body = body;
      return this;
    }),
  } as unknown as Response & { _status?: number; _body?: unknown };
  return res;
}

describe('RpcProxyController', () => {
  it('rejects an oversized body with 413 before touching the service', async () => {
    const service = { handle: vi.fn() } as unknown as RpcProxyService;
    const ctrl = new RpcProxyController(service, makeConfig(100_000));
    const req = makeReq(100_001);
    const res = makeRes();

    await expect(
      ctrl.proxy({ jsonrpc: '2.0', id: 1, method: 'getSlot' }, req, res),
    ).rejects.toThrow(PayloadTooLargeException);
    expect(service.handle).not.toHaveBeenCalled();
  });

  it('forwards to the service and writes its status + body to the response', async () => {
    const result: ProxyResult = { status: 200, body: { jsonrpc: '2.0', id: 1, result: 42 } };
    const service = {
      handle: vi.fn().mockResolvedValue(result),
    } as unknown as RpcProxyService;
    const ctrl = new RpcProxyController(service, makeConfig());
    const body = { jsonrpc: '2.0', id: 1, method: 'getSlot' };
    const req = makeReq(60);
    const res = makeRes();

    await ctrl.proxy(body, req, res);

    expect(service.handle).toHaveBeenCalledWith(body);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(result.body);
  });

  it('propagates a service 400 (disallowed method) verbatim to the response', async () => {
    const result: ProxyResult = {
      status: 400,
      body: { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not allowed' } },
    };
    const service = {
      handle: vi.fn().mockResolvedValue(result),
    } as unknown as RpcProxyService;
    const ctrl = new RpcProxyController(service, makeConfig());
    const res = makeRes();

    await ctrl.proxy({ jsonrpc: '2.0', id: 1, method: 'getProgramAccounts' }, makeReq(80), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(result.body);
  });
});
