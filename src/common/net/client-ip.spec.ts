import { describe, expect, it } from 'vitest';

import { resolveClientIpFromHeaders } from './client-ip.js';

// We pass `trusted` explicitly so the tests don't depend on NODE_ENV.

describe('resolveClientIpFromHeaders (trusted = production)', () => {
  it('uses the leftmost X-Forwarded-For hop (the originating client)', () => {
    const ip = resolveClientIpFromHeaders(
      { 'x-forwarded-for': '203.0.113.7, 70.41.3.18, 150.172.238.178' },
      '10.0.0.1',
      true,
    );
    expect(ip).toBe('203.0.113.7');
  });

  it('gives two different client IPs behind the same hop SEPARATE buckets', () => {
    // Same downstream proxy (fallback addr identical), different real clients.
    const a = resolveClientIpFromHeaders(
      { 'x-forwarded-for': '203.0.113.7, 10.0.0.9' },
      '10.0.0.9',
      true,
    );
    const b = resolveClientIpFromHeaders(
      { 'x-forwarded-for': '198.51.100.22, 10.0.0.9' },
      '10.0.0.9',
      true,
    );
    expect(a).toBe('203.0.113.7');
    expect(b).toBe('198.51.100.22');
    expect(a).not.toBe(b);
  });

  it('falls back to X-Real-IP when XFF is absent', () => {
    const ip = resolveClientIpFromHeaders({ 'x-real-ip': '203.0.113.50' }, '10.0.0.1', true);
    expect(ip).toBe('203.0.113.50');
  });

  it('does NOT crash and falls back to the socket addr when no XFF / X-Real-IP in prod', () => {
    const ip = resolveClientIpFromHeaders({}, '198.51.100.99', true);
    expect(ip).toBe('198.51.100.99');
  });

  it('returns "unknown" when no header and no fallback address', () => {
    expect(resolveClientIpFromHeaders({}, undefined, true)).toBe('unknown');
  });

  it('normalizes the ::ffff: IPv4-mapped-IPv6 prefix on the XFF value', () => {
    const ip = resolveClientIpFromHeaders(
      { 'x-forwarded-for': '::ffff:203.0.113.7' },
      undefined,
      true,
    );
    expect(ip).toBe('203.0.113.7');
  });

  it('normalizes the ::ffff: prefix on the fallback address', () => {
    expect(resolveClientIpFromHeaders({}, '::ffff:192.168.1.1', true)).toBe('192.168.1.1');
  });

  it('handles a repeated (array) XFF header by taking the first entry', () => {
    const ip = resolveClientIpFromHeaders(
      { 'x-forwarded-for': ['203.0.113.7, 10.0.0.9', '8.8.8.8'] },
      '10.0.0.9',
      true,
    );
    expect(ip).toBe('203.0.113.7');
  });
});

describe('resolveClientIpFromHeaders (trusted = false, non-prod)', () => {
  it('IGNORES X-Forwarded-For and uses the direct socket address', () => {
    // A localhost curl could spoof XFF; in non-prod we must not honor it.
    const ip = resolveClientIpFromHeaders({ 'x-forwarded-for': '1.2.3.4' }, '127.0.0.1', false);
    expect(ip).toBe('127.0.0.1');
  });

  it('IGNORES X-Real-IP in non-prod too', () => {
    const ip = resolveClientIpFromHeaders({ 'x-real-ip': '1.2.3.4' }, '127.0.0.1', false);
    expect(ip).toBe('127.0.0.1');
  });
});
