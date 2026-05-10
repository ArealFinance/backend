import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import {
  findAta,
  buildCreateAtaIx,
  buildMintToIx,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
} from './spl-ix.js';

/**
 * Unit tests for SPL instruction builders. Tests cover:
 * - findAta derives correct canonical ATA pubkey
 * - buildCreateAtaIx produces correct instruction structure
 * - buildMintToIx produces correct instruction with proper byte layout
 * - Program IDs are correct
 */

describe('SPL Instruction Builders', () => {
  describe('findAta', () => {
    it('should derive canonical ATA for owner and mint', () => {
      const owner = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;

      const ata = findAta(owner, mint);

      expect(ata).toBeInstanceOf(PublicKey);
      expect(ata.toBase58().length).toBeGreaterThan(0);
    });

    it('should derive deterministic ATA (same result for same inputs)', () => {
      const owner = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;

      const ata1 = findAta(owner, mint);
      const ata2 = findAta(owner, mint);

      expect(ata1.toBase58()).toBe(ata2.toBase58());
    });

    it('should derive different ATAs for different owners', () => {
      const owner1 = Keypair.generate().publicKey;
      const owner2 = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;

      const ata1 = findAta(owner1, mint);
      const ata2 = findAta(owner2, mint);

      expect(ata1.toBase58()).not.toBe(ata2.toBase58());
    });

    it('should derive different ATAs for different mints', () => {
      const owner = Keypair.generate().publicKey;
      const mint1 = Keypair.generate().publicKey;
      const mint2 = Keypair.generate().publicKey;

      const ata1 = findAta(owner, mint1);
      const ata2 = findAta(owner, mint2);

      expect(ata1.toBase58()).not.toBe(ata2.toBase58());
    });

    it('should derive ATA that is a PDA (off-curve)', () => {
      const owner = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;

      const ata = findAta(owner, mint);

      // ATA is always a PDA (off-curve)
      expect(PublicKey.isOnCurve(ata.toBytes())).toBe(false);
    });
  });

  describe('buildCreateAtaIx', () => {
    it('should build CreateAta instruction with correct program ID', () => {
      const payer = Keypair.generate().publicKey;
      const owner = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;

      const ix = buildCreateAtaIx(payer, owner, mint);

      expect(ix.programId.toBase58()).toBe(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58());
    });

    it('should have 6 account keys in correct order', () => {
      const payer = Keypair.generate().publicKey;
      const owner = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;

      const ix = buildCreateAtaIx(payer, owner, mint);

      expect(ix.keys.length).toBe(6);

      // Verify order: payer, ata, owner, mint, system, token
      expect(ix.keys[0].pubkey.toBase58()).toBe(payer.toBase58());
      expect(ix.keys[0].isSigner).toBe(true);
      expect(ix.keys[0].isWritable).toBe(true);

      const ata = findAta(owner, mint);
      expect(ix.keys[1].pubkey.toBase58()).toBe(ata.toBase58());
      expect(ix.keys[1].isSigner).toBe(false);
      expect(ix.keys[1].isWritable).toBe(true);

      expect(ix.keys[2].pubkey.toBase58()).toBe(owner.toBase58());
      expect(ix.keys[2].isSigner).toBe(false);
      expect(ix.keys[2].isWritable).toBe(false);

      expect(ix.keys[3].pubkey.toBase58()).toBe(mint.toBase58());
      expect(ix.keys[3].isSigner).toBe(false);
      expect(ix.keys[3].isWritable).toBe(false);

      expect(ix.keys[4].pubkey.toBase58()).toBe(SYSTEM_PROGRAM_ID.toBase58());
      expect(ix.keys[4].isSigner).toBe(false);
      expect(ix.keys[4].isWritable).toBe(false);

      expect(ix.keys[5].pubkey.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
      expect(ix.keys[5].isSigner).toBe(false);
      expect(ix.keys[5].isWritable).toBe(false);
    });

    it('should have empty data', () => {
      const payer = Keypair.generate().publicKey;
      const owner = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;

      const ix = buildCreateAtaIx(payer, owner, mint);

      expect(ix.data.length).toBe(0);
    });
  });

  describe('buildMintToIx', () => {
    it('should build MintTo instruction with correct program ID', () => {
      const authority = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const dest = Keypair.generate().publicKey;
      const amount = 1_000_000_000n;

      const ix = buildMintToIx(authority, mint, dest, amount);

      expect(ix.programId.toBase58()).toBe(TOKEN_PROGRAM_ID.toBase58());
    });

    it('should have 3 account keys in correct order', () => {
      const authority = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const dest = Keypair.generate().publicKey;
      const amount = 1_000_000_000n;

      const ix = buildMintToIx(authority, mint, dest, amount);

      expect(ix.keys.length).toBe(3);

      // Verify order: mint (writable), dest (writable), authority (signer)
      expect(ix.keys[0].pubkey.toBase58()).toBe(mint.toBase58());
      expect(ix.keys[0].isWritable).toBe(true);
      expect(ix.keys[0].isSigner).toBe(false);

      expect(ix.keys[1].pubkey.toBase58()).toBe(dest.toBase58());
      expect(ix.keys[1].isWritable).toBe(true);
      expect(ix.keys[1].isSigner).toBe(false);

      expect(ix.keys[2].pubkey.toBase58()).toBe(authority.toBase58());
      expect(ix.keys[2].isSigner).toBe(true);
      expect(ix.keys[2].isWritable).toBe(false);
    });

    it('should encode opcode 7 as first byte', () => {
      const authority = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const dest = Keypair.generate().publicKey;
      const amount = 1_000_000_000n;

      const ix = buildMintToIx(authority, mint, dest, amount);

      expect(ix.data[0]).toBe(7);
    });

    it('should encode amount as u64 little-endian', () => {
      const authority = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const dest = Keypair.generate().publicKey;
      const amount = 1_000_000_000n; // 1 billion, typical for USDC

      const ix = buildMintToIx(authority, mint, dest, amount);

      // Data layout: [u8(7), u64-le(amount)]
      expect(ix.data.length).toBe(9);

      // Extract the amount from bytes 1-8 (little-endian)
      const decodedAmount = ix.data.readBigUInt64LE(1);
      expect(decodedAmount).toBe(amount);
    });

    it('should handle large amount values', () => {
      const authority = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const dest = Keypair.generate().publicKey;
      const amount = 10_000_000_000_000n; // 10 trillion (max u64)

      const ix = buildMintToIx(authority, mint, dest, amount);

      const decodedAmount = ix.data.readBigUInt64LE(1);
      expect(decodedAmount).toBe(amount);
    });

    it('should handle zero amount', () => {
      const authority = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const dest = Keypair.generate().publicKey;
      const amount = 0n;

      const ix = buildMintToIx(authority, mint, dest, amount);

      const decodedAmount = ix.data.readBigUInt64LE(1);
      expect(decodedAmount).toBe(0n);
    });

    it('should have data length of exactly 9 bytes', () => {
      const authority = Keypair.generate().publicKey;
      const mint = Keypair.generate().publicKey;
      const dest = Keypair.generate().publicKey;
      const amount = 1_000_000_000n;

      const ix = buildMintToIx(authority, mint, dest, amount);

      expect(ix.data.length).toBe(9);
    });
  });

  describe('Program IDs', () => {
    it('should have correct TOKEN_PROGRAM_ID', () => {
      const expected = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
      expect(TOKEN_PROGRAM_ID.toBase58()).toBe(expected.toBase58());
    });

    it('should have correct ASSOCIATED_TOKEN_PROGRAM_ID', () => {
      const expected = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
      expect(ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()).toBe(expected.toBase58());
    });

    it('should have valid SYSTEM_PROGRAM_ID', () => {
      const systemProgram = new PublicKey('11111111111111111111111111111111');
      expect(SYSTEM_PROGRAM_ID.toBase58()).toBe(systemProgram.toBase58());
    });
  });
});
