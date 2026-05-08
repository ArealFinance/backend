import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';

import { MetricsService } from '../metrics/metrics.service.js';
import type { HandshakeThrottleService } from './handshake-throttle.js';
import { RealtimeGateway, REALTIME_ALLOWED_ORIGINS } from './realtime.gateway.js';

/**
 * Gateway tests. We mock JwtService + Socket and assert the auth-gate
 * behaviour at handler boundaries — the actual Socket.IO transport is
 * a runtime concern (an integration test would spin up a server).
 *
 * MetricsService uses a process-wide prom-client registry; we share one
 * instance across all tests to avoid "metric already registered" errors.
 */

const SHARED_METRICS = new MetricsService();
SHARED_METRICS.onModuleInit();

const VALID_WALLET = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';
const OTHER_WALLET = '8YN7TLUuZx3QmFRaeApaZJSPwtgJWHJWWQyExBzPZQQ8';

function makeJwt(verifyResult: unknown | null = null, throwErr = false): JwtService {
  const verifyAsync = throwErr
    ? vi.fn().mockRejectedValue(new Error('bad token'))
    : vi.fn().mockResolvedValue(verifyResult);
  return { verifyAsync } as unknown as JwtService;
}

function makeSocket(
  opts: {
    authHeader?: string;
    authToken?: string;
    walletData?: string | null;
    address?: string;
  } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.authHeader) headers.authorization = opts.authHeader;
  return {
    handshake: {
      headers,
      auth: opts.authToken ? { token: opts.authToken } : {},
      address: opts.address ?? '127.0.0.1',
    },
    data: opts.walletData !== undefined ? { wallet: opts.walletData } : {},
    join: vi.fn(),
    leave: vi.fn(),
    disconnect: vi.fn(),
  };
}

function makeThrottle(
  outcome: { ok: true } | { ok: false; retryAfterSec: number } = { ok: true },
): HandshakeThrottleService {
  return {
    checkAndRecord: vi.fn().mockResolvedValue(outcome),
  } as unknown as HandshakeThrottleService;
}

function makeGateway(
  jwt: JwtService = makeJwt(),
  throttle: HandshakeThrottleService = makeThrottle(),
): RealtimeGateway {
  return new RealtimeGateway(jwt, SHARED_METRICS, throttle);
}

describe('RealtimeGateway', () => {
  describe('handleConnection', () => {
    it('attaches wallet from valid JWT', async () => {
      const gateway = makeGateway(makeJwt({ sub: VALID_WALLET }));
      const sock = makeSocket({ authHeader: 'Bearer good-token' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await gateway.handleConnection(sock as any);
      expect(sock.data.wallet).toBe(VALID_WALLET);
    });

    it('sets wallet=null on JWT verification failure (anonymous, but not closed)', async () => {
      const gateway = makeGateway(makeJwt(null, true));
      const sock = makeSocket({ authHeader: 'Bearer bad-token' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await gateway.handleConnection(sock as any);
      expect(sock.data.wallet).toBeNull();
    });

    it('disconnects + skips JWT verify when the per-IP throttle rejects', async () => {
      const jwt = makeJwt({ sub: VALID_WALLET });
      const throttle = makeThrottle({ ok: false, retryAfterSec: 7 });
      const gateway = makeGateway(jwt, throttle);
      const sock = makeSocket({ authHeader: 'Bearer good-token', address: '203.0.113.5' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await gateway.handleConnection(sock as any);
      expect(sock.disconnect).toHaveBeenCalledWith(true);
      // Critical: the JWT verify must NOT have been called — this is the
      // whole point of the throttle (deflect bogus-token connect floods
      // before they burn HMAC CPU).
      expect(jwt.verifyAsync).not.toHaveBeenCalled();
    });

    it('fails open on throttle errors (admit the connection, log a warning)', async () => {
      const jwt = makeJwt({ sub: VALID_WALLET });
      const throttle = {
        checkAndRecord: vi.fn().mockRejectedValue(new Error('redis down')),
      } as unknown as HandshakeThrottleService;
      const gateway = makeGateway(jwt, throttle);
      const sock = makeSocket({ authHeader: 'Bearer good-token' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await gateway.handleConnection(sock as any);
      // Connection NOT disconnected — fail-open per the gateway contract.
      expect(sock.disconnect).not.toHaveBeenCalled();
      // JWT verify still runs and the wallet is attached normally.
      expect(jwt.verifyAsync).toHaveBeenCalled();
      expect(sock.data.wallet).toBe(VALID_WALLET);
    });
  });

  describe('handleSubscribe', () => {
    it('accepts the public protocol room without a JWT', () => {
      const gateway = makeGateway();
      const sock = makeSocket({ walletData: null });
      const ack = gateway.handleSubscribe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sock as any,
        { room: 'protocol' },
      );
      expect(ack).toEqual({ ok: true });
      expect(sock.join).toHaveBeenCalledWith('protocol');
    });

    it('accepts a public pool:<base58> room without a JWT', () => {
      const gateway = makeGateway();
      const sock = makeSocket({ walletData: null });
      const ack = gateway.handleSubscribe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sock as any,
        { room: `pool:${VALID_WALLET}` },
      );
      expect(ack).toEqual({ ok: true });
      expect(sock.join).toHaveBeenCalledWith(`pool:${VALID_WALLET}`);
    });

    it('rejects wallet:<base58> for anonymous connections (no JWT)', () => {
      const gateway = makeGateway();
      const sock = makeSocket({ walletData: null });
      const ack = gateway.handleSubscribe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sock as any,
        { room: `wallet:${VALID_WALLET}` },
      );
      expect(ack).toEqual({ ok: false, error: 'auth_required' });
      expect(sock.join).not.toHaveBeenCalled();
    });

    it('rejects wallet:<base58> when JWT sub does not match the room pubkey', () => {
      const gateway = makeGateway();
      const sock = makeSocket({ walletData: OTHER_WALLET });
      const ack = gateway.handleSubscribe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sock as any,
        { room: `wallet:${VALID_WALLET}` },
      );
      expect(ack).toEqual({ ok: false, error: 'auth_mismatch' });
      expect(sock.join).not.toHaveBeenCalled();
    });

    it('accepts wallet:<base58> when JWT sub matches the room pubkey', () => {
      const gateway = makeGateway();
      const sock = makeSocket({ walletData: VALID_WALLET });
      const ack = gateway.handleSubscribe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sock as any,
        { room: `wallet:${VALID_WALLET}` },
      );
      expect(ack).toEqual({ ok: true });
      expect(sock.join).toHaveBeenCalledWith(`wallet:${VALID_WALLET}`);
    });

    it('rejects malformed room names (unknown shape, garbage chars, missing field)', () => {
      const gateway = makeGateway();
      const sock = makeSocket({ walletData: VALID_WALLET });
      const ack1 = gateway.handleSubscribe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sock as any,
        { room: 'not-a-room-shape' },
      );
      const ack2 = gateway.handleSubscribe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sock as any,
        { room: 'pool:!!!!notbase58' },
      );
      const ack3 = gateway.handleSubscribe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sock as any,
        {},
      );
      expect(ack1).toEqual({ ok: false, error: 'unknown_room' });
      expect(ack2).toEqual({ ok: false, error: 'unknown_room' });
      expect(ack3).toEqual({ ok: false, error: 'unknown_room' });
      expect(sock.join).not.toHaveBeenCalled();
    });

    it('subscribe is idempotent — re-joining the same room is a no-op (no error)', () => {
      const gateway = makeGateway();
      const sock = makeSocket({ walletData: null });
      const a = gateway.handleSubscribe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sock as any,
        { room: 'protocol' },
      );
      const b = gateway.handleSubscribe(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        sock as any,
        { room: 'protocol' },
      );
      expect(a).toEqual({ ok: true });
      expect(b).toEqual({ ok: true });
      expect(sock.join).toHaveBeenCalledTimes(2);
    });

    it('cors allow-list is non-empty and pinned (no wildcard)', () => {
      // Defensive guard: a future refactor must NOT introduce '*' here.
      // Wildcard CORS plus credentials is browser-rejected, but more
      // importantly it bypasses the security review for new origins.
      expect(REALTIME_ALLOWED_ORIGINS).toContain('https://app.areal.finance');
      expect(REALTIME_ALLOWED_ORIGINS).not.toContain('*');
    });
  });
});
