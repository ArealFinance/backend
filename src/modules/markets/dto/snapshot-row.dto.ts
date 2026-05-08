import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Wire shape for a single row of `GET /markets/pools/:pool/snapshots`.
 *
 * Numeric fields:
 *   - `tvl_a` / `tvl_b` / `reserve_a` / `reserve_b` / `fee_growth_a` /
 *     `fee_growth_b` / `lp_supply` are `numeric(40,0)` on the DB side and
 *     emitted as decimal STRINGS so JS clients past 2^53 are precision-safe.
 *   - `tvlUsd` is a JS `number | null` — USD aggregates fit comfortably below
 *     2^53 and surface as JS-friendly numbers for chart libraries.
 *   - `blockTime` is unix seconds (chain-side timestamp), parallel to the
 *     SDK's `slot`-then-`blockTime` convention.
 */
export class SnapshotRowDto {
  @ApiProperty() pool!: string;
  @ApiProperty({ description: 'Unix seconds (chain block_time)' }) blockTime!: number;
  @ApiProperty() tvlA!: string;
  @ApiProperty() tvlB!: string;
  @ApiPropertyOptional({ nullable: true }) tvlUsd!: number | null;
  @ApiProperty() reserveA!: string;
  @ApiProperty() reserveB!: string;
  @ApiProperty() feeGrowthA!: string;
  @ApiProperty() feeGrowthB!: string;
  @ApiProperty() lpSupply!: string;
}

export class ListSnapshotsResponseDto {
  @ApiProperty({ type: [SnapshotRowDto] })
  items!: SnapshotRowDto[];
}
