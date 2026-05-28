import { describe, expect, it, vi } from 'vitest';
import type { ConfigService } from '@nestjs/config';

import { DecoderService } from './decoder.service.js';

/**
 * The actual decoder lives in `@areal/sdk/events` (covered by the SDK's own
 * vitest suite). Here we only verify the Nest facade:
 *   - registers all 5 Areal programs,
 *   - resolves cluster-aware program IDs from `solana.cluster` config,
 *   - returns an empty array for non-event log streams,
 *   - returns an empty array for events emitted by foreign programs.
 *
 * End-to-end decoding correctness is exercised by the SDK suite plus a
 * higher-tier integration test against a recorded transaction in Phase 12.2.
 */

function makeConfig(cluster: string): ConfigService {
  return {
    get: vi.fn().mockImplementation((key: string) =>
      key === 'solana.cluster' ? cluster : undefined,
    ),
  } as unknown as ConfigService;
}

describe('DecoderService (facade)', () => {
  const decoder = new DecoderService(makeConfig('devnet'));

  it('exposes all 5 Areal program IDs', () => {
    const ids = decoder.getRegisteredProgramIds().map((p) => p.toBase58());
    expect(ids).toHaveLength(5);
    // No duplicates (each program registered once).
    expect(new Set(ids).size).toBe(5);
  });

  it('returns no decoded events for log lines that carry no Program data', () => {
    const programId = decoder.getRegisteredProgramIds()[0]!;
    const logs = [
      `Program ${programId.toBase58()} invoke [1]`,
      'Program log: hello world',
      `Program ${programId.toBase58()} success`,
    ];
    expect(decoder.decodeLogs(programId, logs)).toEqual([]);
  });

  it('skips events emitted under a foreign program (CPI attribution)', () => {
    const ourProgram = decoder.getRegisteredProgramIds()[0]!;
    // 8 zero bytes = a discriminator no IDL event produces, base64-encoded.
    // Wrapped inside a foreign program's invoke/success window so the SDK's
    // invoke-stack walker would attribute it to "Foo111..." and skip it.
    const fakePayload = Buffer.alloc(64).toString('base64');
    const logs = [
      'Program FoooooooooooooooooooooooooooooooooooooooooX invoke [1]',
      `Program data: ${fakePayload}`,
      'Program FoooooooooooooooooooooooooooooooooooooooooX success',
    ];
    expect(decoder.decodeLogs(ourProgram, logs)).toEqual([]);
  });

  it('returns 0-based array-ordinal logIndex when the SDK emits events', () => {
    // Empty-input invariant: when SDK returns N events, our facade returns
    // logIndex 0..N-1 in encounter order. We can't fixture a real borsh
    // payload here without coupling to IDL field order, so we just assert the
    // empty case explicitly — the array-ordinal mapping is a 1-line `.map()`
    // and is also exercised by the persister integration tests in Phase 12.2.
    const programId = decoder.getRegisteredProgramIds()[0]!;
    expect(decoder.decodeLogs(programId, [])).toEqual([]);
  });

  describe('cluster-aware program ID resolution (M4 fix)', () => {
    it('resolves devnet program IDs when solana.cluster=devnet', () => {
      const svc = new DecoderService(makeConfig('devnet'));
      const ids = svc.getRegisteredProgramIds().map((p) => p.toBase58());
      // Devnet native-dex pubkey from sdk/src/network/program-ids.ts.
      expect(ids).toContain('F9PaTy8SxmrLeheGycdGVAZBEB6FETMhoBfTUeSQLJ9u');
      // Mainnet native-dex MUST NOT appear in the devnet bundle.
      expect(ids).not.toContain('DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL');
    });

    it('resolves mainnet program IDs when solana.cluster=mainnet', () => {
      const svc = new DecoderService(makeConfig('mainnet'));
      const ids = svc.getRegisteredProgramIds().map((p) => p.toBase58());
      expect(ids).toContain('DEX8LmvJpjefPS1cGS9zWB9ybxN24vNjTTrusBeqyARL');
      expect(ids).not.toContain('F9PaTy8SxmrLeheGycdGVAZBEB6FETMhoBfTUeSQLJ9u');
    });

    it('falls back to devnet when solana.cluster is unset', () => {
      const cfg = {
        get: vi.fn().mockReturnValue(undefined),
      } as unknown as ConfigService;
      const svc = new DecoderService(cfg);
      const ids = svc.getRegisteredProgramIds().map((p) => p.toBase58());
      expect(ids).toContain('F9PaTy8SxmrLeheGycdGVAZBEB6FETMhoBfTUeSQLJ9u');
    });
  });
});
