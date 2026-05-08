import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';

import { MetricsService } from '../metrics/metrics.service.js';
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
  } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.authHeader) headers.authorization = opts.authHeader;
  return {
    handshake: {
      headers,
      auth: opts.authToken ? { token: opts.authToken } : {},
    },
    data: opts.walletData !== undefined ? { wallet: opts.walletData } : {},
    join: vi.fn(),
    leave: vi.fn(),
  };
}

function makeGateway(jwt: JwtService = makeJwt()): RealtimeGateway {
  return new RealtimeGateway(jwt, SHARED_METRICS);
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
