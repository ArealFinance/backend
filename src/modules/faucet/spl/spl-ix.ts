import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

/**
 * Pure SPL instruction builders, lifted verbatim from
 * `scripts/lib/bootstrap-init.ts` (the localnet bootstrap script). The
 * faucet deliberately does NOT depend on `@solana/spl-token`: that
 * package is a heavy peer-dep tree (typescript spread across many
 * sub-packages, none of it tree-shaken by Nest) and we only need three
 * narrow primitives. Lifting the byte-level layouts from the script
 * also keeps the bootstrap path and the runtime faucet path in lockstep
 * — if SPL ever bumps an opcode, both files break together.
 */

/** SPL Token program id. */
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

/** Associated Token Account program id. */
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

/** System program id — re-exported for convenience so callers don't need to import web3.js directly. */
export const SYSTEM_PROGRAM_ID = SystemProgram.programId;

/**
 * Canonical ATA derivation: PDA of (owner, token-program, mint) under
 * the associated-token-account program. Mirrors `findAta` in
 * `scripts/lib/bootstrap-init.ts`.
 */
export function findAta(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  )[0];
}

/**
 * Build an `AssociatedTokenProgram::Create` instruction. Empty `data`
 * is the legacy create variant — sufficient for the localnet faucet
 * because we only ever derive standard ATAs against the SPL Token
 * program (Token-2022 is out of scope).
 */
export function buildCreateAtaIx(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  const ata = findAta(owner, mint);
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.alloc(0),
  });
}

/**
 * Build a `Token::MintTo` instruction (opcode 7). Data layout:
 *   [u8(7), u64-le(amountBase)]
 * `amountBase` is in mint-base units (i.e. whole-tokens * 10^decimals).
 * Mirrors `mintTo` in `scripts/lib/bootstrap-init.ts`.
 */
export function buildMintToIx(
  authority: PublicKey,
  mint: PublicKey,
  dest: PublicKey,
  amountBase: bigint,
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0);
  data.writeBigUInt64LE(amountBase, 1);
  return new TransactionInstruction({
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data,
  });
}
