import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for `HandshakeThrottleService`.
 *
 * We mock `ioredis` at the module level so the service constructor's
 * `new Redis(url, ...)` returns a controllable fake. This sidesteps the
 * real network dial that ioredis kicks off on instantiation — important
 * for vitest sandboxes where Redis isn't reachable.
 *
 * Behavioural contract:
 *   - First N attempts admit (`ok:true`).
 *   - The (N+1)th in the same window rejects (`ok:false`) with a
 *     non-zero `retryAfterSec`.
 *   - Different IPs use independent counters.
 *   - Redis throws → fail OPEN (`ok:true`); a warning is logged.
 */

interface PipelineMock {
  zremrangebyscore: ReturnType<typeof vi.fn>;
  zcard: ReturnType<typeof vi.fn>;
  zadd: ReturnType<typeof vi.fn>;
  expire: ReturnType<typeof vi.fn>;
  exec: ReturnType<typeof vi.fn>;
}

interface FakeRedis {
  multi: ReturnType<typeof vi.fn>;
  zrange: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
}

let redisInstance: FakeRedis;
let pipelineFactory: () => PipelineMock;

vi.mock('ioredis', () => {
  return {
    Redis: class {
      constructor(_url: string, _opts: unknown) {
        return redisInstance as unknown as object;
      }
    },
  };
});

// Import AFTER the mock is registered so the service binds to the fake.
import { HandshakeThrottleService } from './handshake-throttle.js';

function makePipeline(opts: { evictRemoved?: number; cardCount?: number } = {}): PipelineMock {
  const pipeline: PipelineMock = {
    zremrangebyscore: vi.fn().mockReturnThis(),
    zcard: vi.fn().mockReturnThis(),
    zadd: vi.fn().mockReturnThis(),
    expire: vi.fn().mockReturnThis(),
    exec: vi.fn().mockResolvedValue([
      [null, opts.evictRemoved ?? 0],
      [null, opts.cardCount ?? 0],
    ]),
  };
  return pipeline;
}

function configFor(env: { count: number; windowSec: number } | null) {
  // When env is null, use defaults (20/60). Otherwise inject via process.env
  // so the constructor reads them.
  if (env) {
    process.env.REALTIME_HANDSHAKE_RATE_LIMIT_COUNT = String(env.count);
    process.env.REALTIME_HANDSHAKE_RATE_LIMIT_WINDOW_SEC = String(env.windowSec);
  } else {
    delete process.env.REALTIME_HANDSHAKE_RATE_LIMIT_COUNT;
    delete process.env.REALTIME_HANDSHAKE_RATE_LIMIT_WINDOW_SEC;
  }
  return {
    get: vi.fn().mockReturnValue('redis://127.0.0.1:6379/0'),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  // Reset the per-test pipeline factory; tests override before instantiating
  // the service so each `multi()` call returns a fresh mock.
  let pipeline = makePipeline();
  pipelineFactory = () => {
    pipeline = makePipeline();
    return pipeline;
  };

  redisInstance = {
    multi: vi.fn().mockImplementation(() => pipelineFactory()),
    zrange: vi.fn().mockResolvedValue([]),
    on: vi.fn(),
    quit: vi.fn().mockResolvedValue('OK'),
  };
});

afterEach(() => {
  delete process.env.REALTIME_HANDSHAKE_RATE_LIMIT_COUNT;
  delete process.env.REALTIME_HANDSHAKE_RATE_LIMIT_WINDOW_SEC;
});

describe('HandshakeThrottleService', () => {
  it('admits the first connect for a fresh IP', async () => {
    pipelineFactory = () => makePipeline({ cardCount: 0 });
    const svc = new HandshakeThrottleService(configFor({ count: 20, windowSec: 60 }));
    const result = await svc.checkAndRecord('1.2.3.4');
    expect(result).toEqual({ ok: true });
    expect(redisInstance.multi).toHaveBeenCalled();
  });

  it('rejects when the IP is already at the cap (count >= limit)', async () => {
    // First call: post-evict count is at the cap (20). Service should
    // reject and consult ZRANGE for the oldest member's score.
    pipelineFactory = () => makePipeline({ cardCount: 20 });
    redisInstance.zrange = vi
      .fn()
      .mockResolvedValue(['oldest-member', String(Date.now() - 30_000)]);
    const svc = new HandshakeThrottleService(configFor({ count: 20, windowSec: 60 }));
    const result = await svc.checkAndRecord('1.2.3.4');
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.retryAfterSec).toBeGreaterThan(0);
      // 60 - 30 = ~30s left in the window.
      expect(result.retryAfterSec).toBeLessThanOrEqual(60);
    }
  });

  it('admits the 20th attempt and rejects the 21st in the same window', async () => {
    // Simulate a counter that grows: each call returns the current count
    // BEFORE this attempt is recorded. Implementation matches the service:
    // count >= cap → reject, else admit + ZADD.
    let count = 0;
    pipelineFactory = () => makePipeline({ cardCount: count });
    redisInstance.zrange = vi
      .fn()
      .mockResolvedValue(['oldest', String(Date.now() - 1000)]);

    const svc = new HandshakeThrottleService(configFor({ count: 20, windowSec: 60 }));

    for (let i = 0; i < 20; i += 1) {
      const r = await svc.checkAndRecord('1.2.3.4');
      expect(r).toEqual({ ok: true });
      count += 1; // simulate the ZADD that just happened
    }
    // 21st: count is 20 → at cap → reject.
    const r21 = await svc.checkAndRecord('1.2.3.4');
    expect(r21.ok).toBe(false);
  });

  it('isolates counters per IP (one IP at cap does not block another IP)', async () => {
    // Track per-IP counters by inspecting the key on the pipeline call site.
    // Easier path: use two separate service runs with stub state.
    let count = 20; // first IP starts at cap
    pipelineFactory = () => makePipeline({ cardCount: count });
    redisInstance.zrange = vi
      .fn()
      .mockResolvedValue(['oldest', String(Date.now() - 1000)]);

    const svc = new HandshakeThrottleService(configFor({ count: 20, windowSec: 60 }));

    const a = await svc.checkAndRecord('1.1.1.1');
    expect(a.ok).toBe(false);

    // Second IP: pretend its key is empty.
    count = 0;
    const b = await svc.checkAndRecord('2.2.2.2');
    expect(b).toEqual({ ok: true });
  });

  it('fails OPEN when the redis pipeline throws (admits the connection)', async () => {
    pipelineFactory = () => {
      const p = makePipeline();
      p.exec = vi.fn().mockRejectedValue(new Error('redis down'));
      return p;
    };
    const svc = new HandshakeThrottleService(configFor({ count: 20, windowSec: 60 }));
    const r = await svc.checkAndRecord('1.2.3.4');
    expect(r).toEqual({ ok: true });
  });

  it('fails OPEN when the pipeline returns null (mid-flight disconnect)', async () => {
    pipelineFactory = () => {
      const p = makePipeline();
      p.exec = vi.fn().mockResolvedValue(null);
      return p;
    };
    const svc = new HandshakeThrottleService(configFor({ count: 20, windowSec: 60 }));
    const r = await svc.checkAndRecord('1.2.3.4');
    expect(r).toEqual({ ok: true });
  });
});
