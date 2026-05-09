import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Wire shape for a row of `GET /markets/pools/:pool/aggregate`.
 *
 * `day` is an ISO 8601 date (`YYYY-MM-DD`, UTC bucket) — the natural
 * primary axis for any UI that renders one bar per day. Volumes/fees are
 * `numeric(40,0)` strings; counts and APY are JS numbers.
 *
 * Phase 12.3.3-I: each row carries the LATEST `pool_snapshots` row's
 * per-token USDC prices + on-chain decimals at-or-before the aggregate's
 * UTC day-end. These are nullable for backward compatibility with rows
 * predating Phase 12.3.3.1 (when `price_*_usdc` / `decimals_*` columns
 * were added) and for pools with no snapshot before the day boundary.
 */
export class DailyAggregateDto {
  @ApiProperty() pool!: string;
  @ApiProperty({ description: 'UTC day bucket (YYYY-MM-DD)' }) day!: string;
  @ApiProperty() volumeA24h!: string;
  @ApiProperty() volumeB24h!: string;
  @ApiProperty() feesA24h!: string;
  @ApiProperty() feesB24h!: string;
  @ApiProperty() txCount24h!: number;
  @ApiProperty() uniqueWallets24h!: number;
  @ApiPropertyOptional({ nullable: true }) apy24h!: number | null;

  /**
   * Latest snapshot's per-token USDC price at or before this day's UTC
   * end. NULL when no snapshot exists for the (pool, day) before this
   * date — pre-Phase-12.3.3.1 rows.
   */
  @ApiPropertyOptional({
    nullable: true,
    description:
      "Latest snapshot's USDC price for token A at or before this day's UTC end. NULL when no snapshot exists for the (pool, day) before this date — pre-Phase-12.3.3.1 rows.",
  })
  priceAUsdc!: number | null;

  /**
   * Latest snapshot's per-token USDC price at or before this day's UTC
   * end. NULL when no snapshot exists for the (pool, day) before this
   * date — pre-Phase-12.3.3.1 rows.
   */
  @ApiPropertyOptional({
    nullable: true,
    description:
      "Latest snapshot's USDC price for token B at or before this day's UTC end. NULL when no snapshot exists for the (pool, day) before this date — pre-Phase-12.3.3.1 rows.",
  })
  priceBUsdc!: number | null;

  /**
   * Latest snapshot's on-chain mint decimals for token A. NULL when no
   * snapshot exists for the (pool, day) before this date — pre-Phase-
   * 12.3.3.1 rows.
   */
  @ApiPropertyOptional({
    nullable: true,
    description:
      "Latest snapshot's on-chain mint decimals for token A. NULL when no snapshot exists for the (pool, day) before this date — pre-Phase-12.3.3.1 rows.",
  })
  decimalsA!: number | null;

  /**
   * Latest snapshot's on-chain mint decimals for token B. NULL when no
   * snapshot exists for the (pool, day) before this date — pre-Phase-
   * 12.3.3.1 rows.
   */
  @ApiPropertyOptional({
    nullable: true,
    description:
      "Latest snapshot's on-chain mint decimals for token B. NULL when no snapshot exists for the (pool, day) before this date — pre-Phase-12.3.3.1 rows.",
  })
  decimalsB!: number | null;

  @ApiProperty({ description: 'ISO 8601 timestamp' }) updatedAt!: string;
}

export class ListAggregateResponseDto {
  @ApiProperty({ type: [DailyAggregateDto] })
  items!: DailyAggregateDto[];
}
