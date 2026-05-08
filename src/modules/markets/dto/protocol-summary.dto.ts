import { ApiProperty } from '@nestjs/swagger';

/**
 * Wire shape for `GET /markets/summary`. Singleton — there's exactly one
 * row in `protocol_summary` and the endpoint surfaces it directly. USD
 * aggregates as JS numbers; counts as ints; `blockTime` as unix seconds.
 */
export class ProtocolSummaryDto {
  @ApiProperty() totalTvlUsd!: number;
  @ApiProperty() volume24hUsd!: number;
  @ApiProperty() txCount24h!: number;
  @ApiProperty() activeWallets24h!: number;
  @ApiProperty() poolCount!: number;
  @ApiProperty() distributorCount!: number;
  @ApiProperty({ description: 'Unix seconds at last refresh' }) blockTime!: number;
  @ApiProperty({ description: 'ISO 8601 timestamp' }) updatedAt!: string;
}
