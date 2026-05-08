import { Counter } from 'prom-client';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service.js';

/**
 * Cryptographic primitives in `AuthService` are pure — they don't touch the
 * DB or JWT module. We instantiate the service with stubbed dependencies and
 * exercise `verifySignature`, `verifyTimestamp`, `verifyMessageStructure`,
 * and `verifyMessageBindsWallet` directly. The login + refresh flows that
 * wire them together are integration-tested separately (Phase 12.2).
 */

/**
 * Build a self-contained MetricsService stub. We don't reuse the real Nest
 * MetricsService because (a) it touches the global prom-client registry on
 * module init (collisions across spec files), and (b) the verification
 * primitives under test never call into metrics — the stub just needs a
 * `labels(...).inc()`-shaped counter to satisfy DI.
 */
function buildMetricsStub(): ConstructorParameters<typeof AuthService>[2] {
  // `registers: []` keeps the counter out of the global registry so each
  // spec file (and each test in this file, since vitest may collect them
  // in parallel) gets a fresh, isolated counter.
  const noop = new Counter({
    name: 'auth_failures_test_stub_total',
    help: 'test stub',
    labelNames: ['reason'],
    registers: [],
  });
  return { authFailures: noop } as unknown as ConstructorParameters<typeof AuthService>[2];
}

function buildSubject(): AuthService {
  // Stubs satisfy DI but should never be called by the methods under test.
  // Cast to `unknown as <Type>` to bypass strict type checks for stubs only.
  return new AuthService(
    { sign: vi.fn() } as unknown as ConstructorParameters<typeof AuthService>[0],
    {
      get: vi.fn().mockReturnValue('stub'),
    } as unknown as ConstructorParameters<typeof AuthService>[1],
    buildMetricsStub(),
    { upsert: vi.fn() } as unknown as ConstructorParameters<typeof AuthService>[3],
    {
      findOne: vi.fn(),
      save: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      update: vi.fn(),
    } as unknown as ConstructorParameters<typeof AuthService>[4],
    // Redis stub — verification primitives never touch it, but the
    // constructor needs the slot filled. `get/incr/expire/del` are the
    // only methods the rate-limiter calls.
    {
      get: vi.fn().mockResolvedValue(null),
      incr: vi.fn().mockResolvedValue(1),
      expire: vi.fn().mockResolvedValue(1),
      del: vi.fn().mockResolvedValue(1),
    } as unknown as ConstructorParameters<typeof AuthService>[5],
  );
}

describe('AuthService.verifySignature', () => {
  const subject = buildSubject();

  it('accepts a valid ed25519 signature', () => {
    const kp = Keypair.generate();
    const wallet = kp.publicKey.toBase58();
    const message = `Login to Areal at ${new Date().toISOString()} for wallet ${wallet}`;
    const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    expect(subject.verifySignature(wallet, bs58.encode(sig), message)).toBe(true);
  });

  it('rejects a signature produced by a different keypair', () => {
    const signer = Keypair.generate();
    const claimedWallet = Keypair.generate().publicKey.toBase58(); // different
    const message = `Login to Areal at ${new Date().toISOString()} for wallet ${claimedWallet}`;
    const sig = nacl.sign.detached(new TextEncoder().encode(message), signer.secretKey);
    expect(subject.verifySignature(claimedWallet, bs58.encode(sig), message)).toBe(false);
  });

  it('rejects mangled signatures without throwing', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    expect(subject.verifySignature(wallet, 'not-base58!@#', 'msg')).toBe(false);
    expect(subject.verifySignature(wallet, bs58.encode(Buffer.alloc(10)), 'msg')).toBe(false);
  });

  it('rejects when the wallet is not a valid pubkey', () => {
    const kp = Keypair.generate();
    const message = 'arbitrary';
    const sig = nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey);
    expect(subject.verifySignature('not-a-pubkey', bs58.encode(sig), message)).toBe(false);
  });
});

describe('AuthService.verifyTimestamp', () => {
  const subject = buildSubject();

  it('accepts a fresh timestamp inside the skew window', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const msg = `Login to Areal at ${new Date().toISOString()} for wallet ${wallet}`;
    expect(subject.verifyTimestamp(msg)).toBe(true);
  });

  it('rejects a timestamp outside the skew window', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
    const msg = `Login to Areal at ${stale} for wallet ${wallet}`;
    expect(subject.verifyTimestamp(msg)).toBe(false);
  });

  it('rejects messages without the expected sentinel', () => {
    expect(subject.verifyTimestamp('Hello world')).toBe(false);
    // Old `at notatimestamp for wallet xxx` form would slip through a loose
    // substring matcher — the anchored regex now requires the full prefix.
    expect(subject.verifyTimestamp('at notatimestamp for wallet xxx')).toBe(false);
  });

  it('accepts the legacy `from <pubkey>` form', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const msg = `Login to Areal at ${new Date().toISOString()} from ${wallet}`;
    expect(subject.verifyTimestamp(msg)).toBe(true);
  });

  it('rejects messages with leading or trailing junk (anchored regex)', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const fresh = new Date().toISOString();
    expect(subject.verifyTimestamp(`prefix Login to Areal at ${fresh} for wallet ${wallet}`)).toBe(
      false,
    );
    expect(subject.verifyTimestamp(`Login to Areal at ${fresh} for wallet ${wallet} suffix`)).toBe(
      false,
    );
  });
});

describe('AuthService.verifyMessageBindsWallet', () => {
  const subject = buildSubject();

  it('matches when the wallet appears verbatim in the message', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const msg = `Login to Areal at ${new Date().toISOString()} for wallet ${wallet}`;
    expect(subject.verifyMessageBindsWallet(msg, wallet)).toBe(true);
  });

  it('rejects messages that name a different wallet field', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const other = Keypair.generate().publicKey.toBase58();
    const msg = `Login to Areal at ${new Date().toISOString()} for wallet ${other}`;
    expect(subject.verifyMessageBindsWallet(msg, wallet)).toBe(false);
  });

  it('rejects substring smuggling — wallet must be the exact field, not anywhere in the text', () => {
    // A naive `message.includes(wallet)` would let an attacker craft
    // "Login to Areal at <ts> for wallet <attacker> trailing <victim>" and
    // pass the binding check (then make the victim sign with their key).
    // Anchored regex + structured equality on the captured field shuts this
    // down — trailing text fails the end-anchor before binding even runs.
    const victim = Keypair.generate().publicKey.toBase58();
    const attacker = Keypair.generate().publicKey.toBase58();
    const msg = `Login to Areal at ${new Date().toISOString()} for wallet ${attacker} extra ${victim}`;
    expect(subject.verifyMessageBindsWallet(msg, victim)).toBe(false);
  });
});
