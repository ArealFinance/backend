import { JwtService } from '@nestjs/jwt';
import { describe, expect, it } from 'vitest';

import { JWT_AUDIENCE, JWT_ISSUER } from './auth.module.js';

/**
 * Defence-in-depth: tokens minted by some FUTURE service that happens to
 * share `JWT_SECRET` must not be accepted by `/auth` or `/realtime`.
 *
 * The contract we care about is round-trip:
 *   1. Tokens signed with the module-level `signOptions` carry iss=areal-backend,
 *      aud=areal-api.
 *   2. The matching `verifyOptions` rejects anything missing or differing on
 *      either claim.
 *
 * We instantiate `JwtService` directly with the same options shape the module
 * passes to `JwtModule.registerAsync.useFactory` — no Nest test bed needed,
 * the JWT library does all the work.
 */
describe('AuthModule JWT iss + aud (R-12.3.1-7)', () => {
  const SECRET = 'unit-test-secret-do-not-use-in-prod';

  function buildIssuer(): JwtService {
    return new JwtService({
      secret: SECRET,
      signOptions: {
        expiresIn: '7d',
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      },
      verifyOptions: {
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
      },
    });
  }

  it('round-trips a token signed with the right iss + aud', async () => {
    const svc = buildIssuer();
    const token = svc.sign({ sub: 'wallet-A' });
    const payload = (await svc.verifyAsync(token)) as { iss: string; aud: string; sub: string };
    expect(payload.iss).toBe(JWT_ISSUER);
    expect(payload.aud).toBe(JWT_AUDIENCE);
    expect(payload.sub).toBe('wallet-A');
  });

  it('rejects a token signed with the wrong issuer', async () => {
    // A "rogue" peer that knows the same secret but stamps a different iss.
    const rogue = new JwtService({
      secret: SECRET,
      signOptions: { expiresIn: '7d', issuer: 'someone-else', audience: JWT_AUDIENCE },
    });
    const verifier = buildIssuer();
    const token = rogue.sign({ sub: 'wallet-A' });
    await expect(verifier.verifyAsync(token)).rejects.toThrow(/issuer/i);
  });

  it('rejects a token signed with the wrong audience', async () => {
    const rogue = new JwtService({
      secret: SECRET,
      signOptions: { expiresIn: '7d', issuer: JWT_ISSUER, audience: 'other-aud' },
    });
    const verifier = buildIssuer();
    const token = rogue.sign({ sub: 'wallet-A' });
    await expect(verifier.verifyAsync(token)).rejects.toThrow(/audience/i);
  });

  it('rejects a token signed without iss / aud at all (legacy / pre-rollout)', async () => {
    const legacy = new JwtService({ secret: SECRET, signOptions: { expiresIn: '7d' } });
    const verifier = buildIssuer();
    const token = legacy.sign({ sub: 'wallet-A' });
    // Missing iss/aud is just as bad as a wrong one — the verifier rejects.
    await expect(verifier.verifyAsync(token)).rejects.toThrow();
  });
});
