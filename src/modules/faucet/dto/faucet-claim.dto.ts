import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

import { DEFAULT_AMOUNT, MAX_AMOUNT } from '../faucet.constants.js';

/**
 * Localnet USDC faucet claim request.
 *
 * `wallet` is validated as base58 (Solana pubkey alphabet) at the DTO
 * layer; the service re-parses with `new PublicKey()` which is the
 * actual gatekeeper. `amount` is optional — clients that omit it get
 * `DEFAULT_AMOUNT` (1000 USDC).
 */
export class FaucetClaimDto {
  @ApiProperty({
    description: 'Solana wallet pubkey to receive the test USDC drip (base58).',
    example: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, {
    message: 'wallet must be a valid base58 Solana pubkey',
  })
  wallet!: string;

  @ApiProperty({
    description: `Drip amount in whole USDC. Defaults to ${DEFAULT_AMOUNT}, hard-capped at ${MAX_AMOUNT}.`,
    required: false,
    default: DEFAULT_AMOUNT,
    minimum: 1,
    maximum: MAX_AMOUNT,
    example: DEFAULT_AMOUNT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT)
  amount?: number;
}
