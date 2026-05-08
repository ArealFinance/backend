import { BadRequestException } from '@nestjs/common';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { PubkeyPipe } from './pubkey.pipe.js';

describe('PubkeyPipe', () => {
  const pipe = new PubkeyPipe();

  it('returns the canonical base58 string for a valid pubkey', () => {
    const kp = Keypair.generate();
    const input = kp.publicKey.toBase58();
    expect(pipe.transform(input)).toBe(input);
  });

  it('rejects empty input', () => {
    expect(() => pipe.transform('')).toThrow(BadRequestException);
  });

  it('rejects non-base58 garbage', () => {
    expect(() => pipe.transform('not!base!58')).toThrow(BadRequestException);
  });

  it('rejects too-short pubkeys', () => {
    expect(() => pipe.transform('abc')).toThrow(BadRequestException);
  });
});
