import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

/**
 * Query parameters for `GET /transactions`.
 *
 * `wallet` is required (we never return cross-wallet activity from a public
 * read); validated to look like a base58 Solana pubkey. `kind` filter is
 * optional and constrained to the projected set so we can rely on it for
 * indexed lookups.
 */
export const TRANSACTION_KINDS = [
  'claim',
  'swap',
  'add_lp',
  'remove_lp',
  'zap_lp',
  'mint_rwt',
] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

export class ListTransactionsDto {
  @ApiPropertyOptional({
    description: 'Wallet to filter transactions for (base58)',
    example: 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK',
  })
  @IsString()
  @Matches(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, { message: 'wallet must be a base58 pubkey' })
  wallet!: string;

  @ApiPropertyOptional({ enum: TRANSACTION_KINDS })
  @IsOptional()
  @IsIn(TRANSACTION_KINDS as readonly string[])
  kind?: TransactionKind;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;

  @ApiPropertyOptional({ description: 'Opaque cursor returned by previous page' })
  @IsOptional()
  @IsString()
  before?: string;
}
