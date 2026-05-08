import { describe, expect, it, vi } from 'vitest';

import { HealthController } from './health.controller.js';

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
