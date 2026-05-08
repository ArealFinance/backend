import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import configuration from './configuration.js';

/**
 * Boot-time fail-fast guard (R-12.3.1-8). The factory MUST throw when
 * `JWT_SECRET` or `JWT_REFRESH_SECRET` is unset — silently defaulting to
 * empty would let the process start, then surface as cryptic 401s on
 * the first authenticated request. The throw belongs INSIDE the factory
 * (not at module load) so dev-tools that import this file for type-only
 * purposes don't trip it.
 */
describe('configuration() — fail-fast on missing JWT secrets', () => {
  let originalSecret: string | undefined;
  let originalRefreshSecret: string | undefined;

  beforeEach(() => {
    originalSecret = process.env.JWT_SECRET;
    originalRefreshSecret = process.env.JWT_REFRESH_SECRET;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = originalSecret;
    if (originalRefreshSecret === undefined) delete process.env.JWT_REFRESH_SECRET;
    else process.env.JWT_REFRESH_SECRET = originalRefreshSecret;
  });

  it('throws when JWT_SECRET is unset', () => {
    delete process.env.JWT_SECRET;
    process.env.JWT_REFRESH_SECRET = 'present';
    expect(() => configuration()).toThrow(/JWT_SECRET/);
  });

  it('throws when JWT_SECRET is the empty string', () => {
    process.env.JWT_SECRET = '';
    process.env.JWT_REFRESH_SECRET = 'present';
    expect(() => configuration()).toThrow(/JWT_SECRET/);
  });

  it('throws when JWT_REFRESH_SECRET is unset', () => {
    process.env.JWT_SECRET = 'present';
    delete process.env.JWT_REFRESH_SECRET;
    expect(() => configuration()).toThrow(/JWT_REFRESH_SECRET/);
  });

  it('does not throw and returns a populated config when both secrets are set', () => {
    process.env.JWT_SECRET = 'unit-test-secret';
    process.env.JWT_REFRESH_SECRET = 'unit-test-refresh-secret';
    const cfg = configuration();
    expect(cfg.jwt.secret).toBe('unit-test-secret');
    expect(cfg.jwt.refreshSecret).toBe('unit-test-refresh-secret');
  });
});
