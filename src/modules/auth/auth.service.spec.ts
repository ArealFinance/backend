import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import { AuthService } from './auth.service.js';

/**
 * Cryptographic primitives in `AuthService` are pure — they don't touch the
 * DB or JWT module. We instantiate the service with stubbed dependencies and
 * exercise `verifySignature`, `verifyTimestamp`, and `verifyMessageBindsWallet`
 * directly. The login flow that wires them together is integration-tested
 * separately (out of scope for Phase 12.1 unit suite).
 */

function buildSubject(): AuthService {
  // Stubs satisfy DI but should never be called by the methods under test.
  // Cast to `unknown as <Type>` to bypass strict type checks for stubs only.
  return new AuthService(
    { sign: vi.fn() } as unknown as ConstructorParameters<typeof AuthService>[0],
    {
      get: vi.fn().mockReturnValue('stub'),
    } as unknown as ConstructorParameters<typeof AuthService>[1],
    { upsert: vi.fn() } as unknown as ConstructorParameters<typeof AuthService>[2],
    {
      findOne: vi.fn(),
      save: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    } as unknown as ConstructorParameters<typeof AuthService>[3],
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
    expect(subject.verifyTimestamp('at notatimestamp for wallet xxx')).toBe(false);
  });

  it('accepts the legacy `from <pubkey>` form', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const msg = `Login to Areal at ${new Date().toISOString()} from ${wallet}`;
    expect(subject.verifyTimestamp(msg)).toBe(true);
  });
});

describe('AuthService.verifyMessageBindsWallet', () => {
  const subject = buildSubject();

  it('matches when the wallet appears verbatim in the message', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const msg = `Login to Areal at ${new Date().toISOString()} for wallet ${wallet}`;
    expect(subject.verifyMessageBindsWallet(msg, wallet)).toBe(true);
  });

  it('rejects messages that omit the wallet pubkey', () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const msg = `Login to Areal at ${new Date().toISOString()} for wallet SOMEONE_ELSE`;
    expect(subject.verifyMessageBindsWallet(msg, wallet)).toBe(false);
  });
});
