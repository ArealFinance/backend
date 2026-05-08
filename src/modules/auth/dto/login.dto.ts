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
  @Matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, {
    message: 'wallet must be a valid base58 Solana pubkey',
  })
  wallet!: string;

  @ApiProperty({ description: 'ed25519 signature of `message`, base58-encoded' })
  @IsString()
  @IsNotEmpty()
  @MinLength(64)
  @MaxLength(128)
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
