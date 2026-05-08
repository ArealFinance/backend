import { afterEach, describe, expect, it, vi } from 'vitest';

import { HealthController, scrubProbeError } from './health.controller.js';

describe('HealthController', () => {
  it('reports ok when both DB and RPC respond', async () => {
    const ds = { query: vi.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const conn = { getSlot: vi.fn().mockResolvedValue(123n) };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new HealthController(ds as any, conn as any);
    const result = await ctrl.check();
    expect(result.status).toBe('ok');
    expect(result.dependencies.database.status).toBe('ok');
    expect(result.dependencies.rpc.status).toBe('ok');
  });

  it('reports degraded when DB is down', async () => {
    const ds = { query: vi.fn().mockRejectedValue(new Error('connection refused')) };
    const conn = { getSlot: vi.fn().mockResolvedValue(123n) };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new HealthController(ds as any, conn as any);
    const result = await ctrl.check();
    expect(result.status).toBe('degraded');
    expect(result.dependencies.database.status).toBe('down');
    expect(result.dependencies.database.detail).toContain('connection refused');
    expect(result.dependencies.rpc.status).toBe('ok');
  });

  it('reports degraded when RPC is down', async () => {
    const ds = { query: vi.fn().mockResolvedValue([{ '?column?': 1 }]) };
    const conn = { getSlot: vi.fn().mockRejectedValue(new Error('rpc 500')) };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctrl = new HealthController(ds as any, conn as any);
    const result = await ctrl.check();
    expect(result.status).toBe('degraded');
    expect(result.dependencies.rpc.status).toBe('down');
  });
});

describe('scrubProbeError', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('returns the raw message outside production', () => {
    process.env.NODE_ENV = 'development';
    expect(scrubProbeError('connection refused at 10.0.0.1:5432')).toBe(
      'connection refused at 10.0.0.1:5432',
    );
  });

  it('categorises as timeout in production', () => {
    process.env.NODE_ENV = 'production';
    expect(scrubProbeError('request timeout after 5000ms')).toBe('timeout');
    expect(scrubProbeError('connect ETIMEDOUT 1.2.3.4:443')).toBe('timeout');
  });

  it('categorises as auth_failed in production for 401/403/unauthorized', () => {
    process.env.NODE_ENV = 'production';
    expect(scrubProbeError('rpc returned 401')).toBe('auth_failed');
    expect(scrubProbeError('Unauthorized: bad api key')).toBe('auth_failed');
  });

  it('categorises everything else as unreachable in production', () => {
    process.env.NODE_ENV = 'production';
    expect(scrubProbeError('connection refused at 10.0.0.1:5432')).toBe('unreachable');
    expect(scrubProbeError('ENOTFOUND api.devnet.solana.com')).toBe('unreachable');
  });
});
