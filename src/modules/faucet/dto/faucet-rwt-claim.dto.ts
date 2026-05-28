import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

import { DEFAULT_RWT_AMOUNT, MAX_RWT_AMOUNT } from '../faucet.constants.js';

/**
 * Devnet RWT faucet claim request.
 *
 * Mirrors `FaucetClaimDto` (USDC) but with RWT-specific amount bounds:
 *   - Default: 100 RWT (vs USDC's 1000).
 *   - Hard cap: 1,000 RWT (vs USDC's 10,000) — RWT supply is bounded by
 *     the manually-topped-up treasury ATA, so we keep the per-request
 *     ceiling tighter than the USDC mint-from-thin-air faucet.
 *
 * `wallet` is validated as base58 (Solana pubkey alphabet) at the DTO
 * layer; the service re-parses with `new PublicKey()` which is the
 * actual gatekeeper.
 */
export class FaucetRwtClaimDto {
  @ApiProperty({
    description: 'Solana wallet pubkey to receive the test RWT drip (base58).',
    example: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, {
    message: 'wallet must be a valid base58 Solana pubkey',
  })
  wallet!: string;

  @ApiProperty({
    description: `Drip amount in whole RWT. Defaults to ${DEFAULT_RWT_AMOUNT}, hard-capped at ${MAX_RWT_AMOUNT}.`,
    required: false,
    default: DEFAULT_RWT_AMOUNT,
    minimum: 1,
    maximum: MAX_RWT_AMOUNT,
    example: DEFAULT_RWT_AMOUNT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_RWT_AMOUNT)
  amount?: number;
}
