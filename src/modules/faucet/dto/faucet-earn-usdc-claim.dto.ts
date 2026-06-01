import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

import { DEFAULT_EARN_USDC_AMOUNT, MAX_EARN_USDC_AMOUNT } from '../faucet.constants.js';

/**
 * Devnet/localnet earn-USDC faucet claim request.
 *
 * Mirrors `FaucetClaimDto` (localnet USDC) but with earn-USDC amount bounds:
 *   - Default: 100 earn-USDC.
 *   - Hard cap: 1,000 earn-USDC.
 *
 * `wallet` is validated as base58 (Solana pubkey alphabet) at the DTO layer;
 * the service re-parses with `new PublicKey()` (and rejects off-curve PDAs)
 * which is the actual gatekeeper.
 */
export class FaucetEarnUsdcClaimDto {
  @ApiProperty({
    description: 'Solana wallet pubkey to receive the test earn-USDC drip (base58).',
    example: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, {
    message: 'wallet must be a valid base58 Solana pubkey',
  })
  wallet!: string;

  @ApiProperty({
    description: `Drip amount in whole earn-USDC. Defaults to ${DEFAULT_EARN_USDC_AMOUNT}, hard-capped at ${MAX_EARN_USDC_AMOUNT}.`,
    required: false,
    default: DEFAULT_EARN_USDC_AMOUNT,
    minimum: 1,
    maximum: MAX_EARN_USDC_AMOUNT,
    example: DEFAULT_EARN_USDC_AMOUNT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_EARN_USDC_AMOUNT)
  amount?: number;
}
