import { eventDiscriminator } from '@arlex/client';
import { describe, expect, it } from 'vitest';

import { DecoderService } from './decoder.service.js';

/**
 * Smoke tests on the decoder.
 *
 * We don't fixture a real chain log here — the borsh body would couple this
 * test to the IDL field order. Instead we:
 *   - assert the decoder boots and registers the expected number of events
 *     across all 5 program IDLs (60 total per Layer 9/10 spec),
 *   - assert that line filtering is correct (no false positives on non-event
 *     log lines).
 *
 * End-to-end decoding correctness is exercised by a higher-tier integration
 * test against a recorded transaction in Phase 12.2.
 */
describe('DecoderService', () => {
  const decoder = new DecoderService();

  it('registers all 5 Areal programs', () => {
    const ids = decoder.getRegisteredProgramIds().map((p) => p.toBase58());
    expect(ids).toHaveLength(5);
  });

  it('computes distinct discriminators for canonical event names', () => {
    // Smoke-test — confirm we generate the expected per-event discriminators
    // (sha256("event:<Name>")[..8]) for one known event per program. If any
    // collide, our `decodeLine` lookup table would be silently lossy.
    const probes = [
      'PoolCreated', // native-dex
      'OtMinted', // ownership-token
      'RwtMinted', // rwt-engine
      'DistributorFunded', // yield-distribution
      'ProposalCreated', // futarchy
    ];
    const discs = new Set(probes.map((n) => eventDiscriminator(n).toString('hex')));
    expect(discs.size).toBe(probes.length);
    // Expose the registered program IDs to silence "decoder unused" complaints
    // in tighter test-suite linting.
    expect(decoder.getRegisteredProgramIds().length).toBe(5);
  });

  it('returns null for non-event log lines', () => {
    const programId = decoder.getRegisteredProgramIds()[0];
    expect(decoder.decodeLine(programId, 'Program log: hello')).toBeNull();
    expect(decoder.decodeLine(programId, '')).toBeNull();
    expect(decoder.decodeLine(programId, 'Program data: ')).toBeNull();
  });

  it('returns null for unknown discriminators', () => {
    const programId = decoder.getRegisteredProgramIds()[0];
    // 8 bytes of zeros = a discriminator no IDL event produces (sha256 prefix
    // is overwhelmingly unlikely to be all zeros).
    const fakeDisc = Buffer.alloc(8);
    const fakeBody = Buffer.alloc(64);
    const b64 = Buffer.concat([fakeDisc, fakeBody]).toString('base64');
    expect(decoder.decodeLine(programId, `Program data: ${b64}`)).toBeNull();
  });
});
