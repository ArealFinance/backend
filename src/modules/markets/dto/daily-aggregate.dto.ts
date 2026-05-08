import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Wire shape for a row of `GET /markets/pools/:pool/aggregate`.
 *
 * `day` is an ISO 8601 date (`YYYY-MM-DD`, UTC bucket) — the natural
 * primary axis for any UI that renders one bar per day. Volumes/fees are
 * `numeric(40,0)` strings; counts and APY are JS numbers.
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
  @ApiProperty({ description: 'ISO 8601 timestamp' }) updatedAt!: string;
}

export class ListAggregateResponseDto {
  @ApiProperty({ type: [DailyAggregateDto] })
  items!: DailyAggregateDto[];
}
