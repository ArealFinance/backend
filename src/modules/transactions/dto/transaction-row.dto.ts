import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

import type { TransactionKind } from './list-transactions.dto.js';

/**
 * Wire shape for a single row of `GET /transactions`. Numeric fields are
 * strings (numeric(40,0) on the DB side) so JS clients don't lose precision
 * past 2^53.
 */
export class TransactionRowDto {
  @ApiProperty() signature!: string;
  @ApiProperty() logIndex!: number;
  @ApiProperty() kind!: TransactionKind;
  @ApiProperty() wallet!: string;
  @ApiPropertyOptional() otMint!: string | null;
  @ApiPropertyOptional() pool!: string | null;
  @ApiPropertyOptional() amountA!: string | null;
  @ApiPropertyOptional() amountB!: string | null;
  @ApiPropertyOptional() sharesDelta!: string | null;
  @ApiProperty({ description: 'block_time as ISO 8601 UTC' }) blockTime!: string;
  @ApiProperty({ description: 'Solana slot as decimal string (uint64-safe)' }) slot!: string;
}

export class ListTransactionsResponseDto {
  @ApiProperty({ type: [TransactionRowDto] })
  items!: TransactionRowDto[];

  @ApiPropertyOptional({
    nullable: true,
    description: 'Opaque cursor for the next page; null if no more rows',
  })
  nextCursor!: string | null;
}
