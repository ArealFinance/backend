import { describe, expect, it } from 'vitest';

import { extractOtMint, extractPool, extractPrimaryActor } from './persister.service.js';

/**
 * The denormalisation helpers are pure — easy to test directly. The
 * UPSERT itself is exercised against a real Postgres in the integration
 * suite (Phase 12.2 onwards).
 */
describe('persister field extraction', () => {
  it('extracts the primary actor across multiple field names', () => {
    expect(extractPrimaryActor({ user: 'A' })).toBe('A');
    expect(extractPrimaryActor({ depositor: 'B' })).toBe('B');
    expect(extractPrimaryActor({ swapper: 'C' })).toBe('C');
    expect(extractPrimaryActor({ claimant: 'D' })).toBe('D');
    expect(extractPrimaryActor({ recipient: 'E' })).toBe('E');
    expect(extractPrimaryActor({ authority: 'F' })).toBe('F');
    expect(extractPrimaryActor({ funder: 'G' })).toBe('G');
  });

  it('returns null when no candidate field is present', () => {
    expect(extractPrimaryActor({ amount: 100 })).toBeNull();
    expect(extractPrimaryActor({})).toBeNull();
  });

  it('prefers the first matching key in declaration order', () => {
    // user > depositor in the priority list
    expect(extractPrimaryActor({ user: 'A', depositor: 'B' })).toBe('A');
  });

  it('ignores non-string actor values', () => {
    expect(extractPrimaryActor({ user: 42 })).toBeNull();
    expect(extractPrimaryActor({ user: '' })).toBeNull();
    expect(extractPrimaryActor({ user: null })).toBeNull();
  });

  it('extracts pool from canonical field names (camelCase per SDK decoder)', () => {
    expect(extractPool({ pool: 'P1' })).toBe('P1');
    expect(extractPool({ nexusPool: 'P2' })).toBe('P2');
    expect(extractPool({ lpPosition: 'L1' })).toBe('L1');
    expect(extractPool({ distributor: 'D1' })).toBe('D1');
    expect(extractPool({ market: 'M1' })).toBe('M1');
    expect(extractPool({})).toBeNull();
  });

  it('extracts otMint from canonical field names (camelCase per SDK decoder)', () => {
    expect(extractOtMint({ otMint: 'OT1' })).toBe('OT1');
    expect(extractOtMint({ mint: 'M1' })).toBe('M1');
    expect(extractOtMint({ rwtMint: 'R1' })).toBe('R1');
    expect(extractOtMint({})).toBeNull();
  });

  it('does NOT match snake_case keys (regression for Phase 12.1 latent bug)', () => {
    // SDK decoder remaps snake_case → camelCase in `remapPayload`; if a
    // future refactor reintroduces snake_case lookup, every event would
    // land with NULL denormalised columns.
    expect(extractPool({ nexus_pool: 'P2' })).toBeNull();
    expect(extractOtMint({ ot_mint: 'OT1' })).toBeNull();
    expect(extractOtMint({ rwt_mint: 'R1' })).toBeNull();
  });
});
