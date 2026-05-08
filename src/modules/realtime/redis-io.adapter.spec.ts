import { IoAdapter } from '@nestjs/platform-socket.io';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Adapter unit tests (R-12.3.1-5).
 *
 * Most security-critical path: `createIOServer` overrides `cors.origin` to
 * `REALTIME_ALLOWED_ORIGINS` and `transports` to `['websocket']` regardless
 * of what NestJS passes in via the gateway decorator. A future gateway
 * change that drops the cors field MUST NOT silently disable the allow-list.
 *
 * We mock both `ioredis` and `@socket.io/redis-adapter` at module level
 * so the spec runs without any network dependency. The parent IoAdapter's
 * `createIOServer` is also stubbed via prototype patching — we don't care
 * what Socket.IO does with the merged options, only that we MERGED them
 * correctly before delegating.
 */

// Module-level mocks must be declared BEFORE the import of the SUT.
// Vitest hoists `vi.mock` to the top of the file regardless of source
// position, but keeping them visually first matches reader expectation.
vi.mock('ioredis', () => {
  const Redis = vi.fn().mockImplementation(function (this: unknown) {
    // Return a minimal object whose `duplicate()` and `quit()` are spies
    // we can read out of any instance. Using `this` so each `new Redis()`
    // call gets its own instance with traceable methods.
    const instance = {
      duplicate: vi.fn(),
      quit: vi.fn().mockResolvedValue(undefined),
    };
    instance.duplicate.mockReturnValue({
      duplicate: vi.fn(),
      quit: vi.fn().mockResolvedValue(undefined),
    });
    Object.assign(this as object, instance);
    return instance;
  });
  return { Redis };
});

vi.mock('@socket.io/redis-adapter', () => ({
  // The adapter ctor is opaque — we just need it callable and identifiable
  // as a function so RealtimeRedisIoAdapter can store the return value.
  createAdapter: vi.fn(() => vi.fn()),
}));

// Imports AFTER the vi.mock declarations to ensure mocks are applied.
const { RealtimeRedisIoAdapter } = await import('./redis-io.adapter.js');
const { REALTIME_ALLOWED_ORIGINS } = await import('./realtime.gateway.js');
const { Redis } = await import('ioredis');
const { createAdapter } = await import('@socket.io/redis-adapter');

describe('RealtimeRedisIoAdapter', () => {
  // Capture-and-restore parent `createIOServer` so each test gets a fresh
  // spy that doesn't actually instantiate a real Socket.IO server.
  let originalCreateIOServer: IoAdapter['createIOServer'];

  beforeEach(() => {
    originalCreateIOServer = IoAdapter.prototype.createIOServer;
    vi.clearAllMocks();
  });

  afterEach(() => {
    IoAdapter.prototype.createIOServer = originalCreateIOServer;
  });

  describe('connectToRedis', () => {
    it('instantiates pub + sub clients with the provided URL', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = new RealtimeRedisIoAdapter({} as any);

      await adapter.connectToRedis('redis://test:6379/0');

      expect(Redis).toHaveBeenCalled();
      // The first call to the Redis ctor is the pub client; the duplicate()
      // on it produces the sub. We only need to assert the pub URL — sub
      // is forced to mirror via the mocked duplicate().
      expect((Redis as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]).toBeDefined();
      expect((Redis as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]).toBe(
        'redis://test:6379/0',
      );
      expect(createAdapter).toHaveBeenCalledOnce();
    });
  });

  describe('createIOServer', () => {
    it('overrides cors.origin to the pinned allow-list', () => {
      // Stub super.createIOServer so it doesn't try to spin up a real
      // Socket.IO server (which would open a port).
      const fakeServer: { adapter: ReturnType<typeof vi.fn> } = { adapter: vi.fn() };
      const superSpy = vi.fn().mockReturnValue(fakeServer);
      IoAdapter.prototype.createIOServer = superSpy as unknown as IoAdapter['createIOServer'];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = new RealtimeRedisIoAdapter({} as any);
      // A "malicious" caller passing wildcard cors — the adapter must
      // override it back to the allow-list.
      adapter.createIOServer(3010, {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        cors: { origin: '*' } as any,
      } as never);

      expect(superSpy).toHaveBeenCalledOnce();
      const merged = superSpy.mock.calls[0]![1] as {
        cors: { origin: string[]; credentials: boolean };
        transports: string[];
      };
      expect(merged.cors.origin).toEqual(REALTIME_ALLOWED_ORIGINS);
      expect(merged.cors.credentials).toBe(true);
    });

    it('forces transports to websocket-only (no long-poll)', () => {
      const fakeServer: { adapter: ReturnType<typeof vi.fn> } = { adapter: vi.fn() };
      const superSpy = vi.fn().mockReturnValue(fakeServer);
      IoAdapter.prototype.createIOServer = superSpy as unknown as IoAdapter['createIOServer'];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = new RealtimeRedisIoAdapter({} as any);
      adapter.createIOServer(3010, {
        // Caller asks for both transports — adapter restricts to websocket.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        transports: ['polling', 'websocket'] as any,
      } as never);

      const merged = superSpy.mock.calls[0]![1] as { transports: string[] };
      expect(merged.transports).toEqual(['websocket']);
    });
  });

  describe('disposeRedis', () => {
    it('calls quit() on both pub and sub clients', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapter = new RealtimeRedisIoAdapter({} as any);
      await adapter.connectToRedis('redis://test:6379/0');

      // Reach into the adapter to grab the pub / sub instances we just
      // created — they're private but accessible via cast.
      const inner = adapter as unknown as {
        pub: { quit: ReturnType<typeof vi.fn> } | null;
        sub: { quit: ReturnType<typeof vi.fn> } | null;
      };
      const pubQuit = inner.pub?.quit;
      const subQuit = inner.sub?.quit;
      expect(pubQuit).toBeDefined();
      expect(subQuit).toBeDefined();

      await adapter.disposeRedis();

      expect(pubQuit).toHaveBeenCalledOnce();
      expect(subQuit).toHaveBeenCalledOnce();
      // Adapter clears its references after dispose.
      expect(inner.pub).toBeNull();
      expect(inner.sub).toBeNull();
    });
  });
});
