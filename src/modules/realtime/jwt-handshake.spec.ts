import { describe, expect, it } from 'vitest';

import { extractJwtFromHandshake } from './jwt-handshake.js';

/**
 * Header-vs-body precedence is THE security-relevant invariant: a malicious
 * client could send `auth.token = '<attacker token>'` while the legitimate
 * Authorization header carries the user's real token. The handshake helper
 * picks the header — these tests pin that contract.
 */
describe('extractJwtFromHandshake', () => {
  it('returns the bearer token from the Authorization header', () => {
    const token = extractJwtFromHandshake({
      handshake: { headers: { authorization: 'Bearer header-token' }, auth: {} },
    });
    expect(token).toBe('header-token');
  });

  it('returns the auth.token field when no Authorization header is set', () => {
    const token = extractJwtFromHandshake({
      handshake: { headers: {}, auth: { token: 'auth-payload-token' } },
    });
    expect(token).toBe('auth-payload-token');
  });

  it('prefers the Authorization header over auth.token (header wins)', () => {
    const token = extractJwtFromHandshake({
      handshake: {
        headers: { authorization: 'Bearer header-wins' },
        auth: { token: 'should-be-ignored' },
      },
    });
    expect(token).toBe('header-wins');
  });

  it('returns null for malformed / missing inputs (no Bearer prefix, empty string)', () => {
    expect(
      extractJwtFromHandshake({
        handshake: { headers: { authorization: 'Basic xyz' }, auth: {} },
      }),
    ).toBeNull();
    expect(extractJwtFromHandshake({ handshake: { headers: {}, auth: { token: '' } } })).toBeNull();
    expect(extractJwtFromHandshake({ handshake: { headers: {}, auth: {} } })).toBeNull();
  });
});
