import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/**
 * Wallet-signature login.
 *
 * The client builds a `message` of the form:
 *   `Login to Areal at <ISO-8601 timestamp> for wallet <pubkey>`
 *
 * signs it with their wallet, base58-encodes the signature, and POSTs all
 * three fields. The backend re-derives the message bytes, ed25519-verifies
 * the signature against the wallet pubkey, and (if valid + within
 * timestamp-skew window) issues a JWT.
 */
export class LoginDto {
  @ApiProperty({
    description: 'Solana wallet pubkey (base58)',
    example: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
  })
  @IsString()
  @IsNotEmpty()
  // Solana pubkeys are 32 bytes → 43-44 base58 chars in practice. We
  // accept 32-44 to keep theoretical edge cases (leading-zero-byte keys
  // that base58-shorten) from being rejected, but the regex itself
  // restricts the alphabet to base58 (excludes 0/O/I/l). Tighter than
  // 32-44 would risk false negatives without meaningfully narrowing the
  // attack surface — `canonicaliseWallet` in AuthService re-parses with
  // `new PublicKey()` which is the actual gatekeeper.
  @Matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, {
    message: 'wallet must be a valid base58 Solana pubkey',
  })
  wallet!: string;

  // ed25519 signatures are 64 bytes → 86-88 base58 chars. The previous
  // 64-128 band was loose enough to admit ~50% bogus payloads to the
  // expensive verification path; 86-90 keeps a small headroom for any
  // base58-encoder quirk while still rejecting obvious junk before the
  // ed25519 verifier sees it. The verifier itself rechecks the byte
  // length (`!== nacl.sign.signatureLength`) so this DTO bound is purely
  // a cheap pre-filter.
  @ApiProperty({ description: 'ed25519 signature of `message`, base58-encoded' })
  @IsString()
  @IsNotEmpty()
  @MinLength(86)
  @MaxLength(90)
  signature!: string;

  @ApiProperty({
    description:
      'The exact UTF-8 message that was signed. Must include the wallet and an ISO-8601 timestamp within the server-enforced skew window.',
    example: 'Login to Areal at 2026-05-08T12:34:56.000Z for wallet DYw8...',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  message!: string;
}
