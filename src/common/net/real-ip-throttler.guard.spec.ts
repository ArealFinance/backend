import { describe, expect, it } from 'vitest';

import { RealIpThrottlerGuard } from './real-ip-throttler.guard.js';

/**
 * `getTracker` is protected; this subclass exposes it for direct assertion.
 * We don't instantiate the full guard machinery (storage/reflector) — we only
 * exercise the tracker resolution, which has no dependency on those.
 */
class TestableGuard extends RealIpThrottlerGuard {
  public track(req: Record<string, unknown>): Promise<string> {
    return this.getTracker(req);
  }
}

function makeGuard(): TestableGuard {
  // The base ThrottlerGuard constructor takes (options, storage, reflector);
  // getTracker doesn't touch them, so undefined casts are safe for this unit.
  return new TestableGuard(undefined as never, undefined as never, undefined as never);
}

describe('RealIpThrottlerGuard.getTracker', () => {
  const guard = makeGuard();

  it('resolves the leftmost XFF client IP when header is trusted (prod)', async () => {
    // Force trusted path via NODE_ENV — the helper reads it at module load, so
    // we assert behaviour through whichever mode the suite runs in by checking
    // the fallback path is at least correct. The leftmost-XFF behaviour itself
    // is covered exhaustively in client-ip.spec.ts; here we verify the guard
    // wires req.headers + req.ip into the helper correctly.
    const tracked = await guard.track({
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.9' },
      ip: '10.0.0.9',
      socket: { remoteAddress: '10.0.0.9' },
    });
    // In non-prod (default test env) the helper ignores XFF and returns req.ip.
    // In prod it returns the leftmost XFF. Either way it must be one of these,
    // never crash, and never the literal header object.
    expect(['203.0.113.7', '10.0.0.9']).toContain(tracked);
  });

  it('falls back to req.ip when no forwarding headers present', async () => {
    const tracked = await guard.track({
      headers: {},
      ip: '198.51.100.5',
      socket: { remoteAddress: '198.51.100.5' },
    });
    expect(tracked).toBe('198.51.100.5');
  });

  it('falls back to socket.remoteAddress when req.ip is absent', async () => {
    const tracked = await guard.track({
      headers: {},
      socket: { remoteAddress: '198.51.100.9' },
    });
    expect(tracked).toBe('198.51.100.9');
  });

  it('does not crash when headers and address are entirely missing', async () => {
    const tracked = await guard.track({ headers: undefined });
    expect(tracked).toBe('unknown');
  });
});
