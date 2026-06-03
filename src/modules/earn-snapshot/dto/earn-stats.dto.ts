import { ApiProperty } from '@nestjs/swagger';

/**
 * Annualised APY per window, derived from stRWT-rate growth.
 *
 * Each field is `null` when the available history is shorter than the requested
 * window — we refuse to annualise a tiny elapsed span into a 30-day claim (the
 * honesty rule). A genuine 0 (rate hasn't moved → no rewards) is returned as
 * `0`, not null. Values are ratios (0.12 = 12% APY).
 */
export class EarnApyDto {
  @ApiProperty({
    description: '24h-window annualised APY (ratio, 0.12 = 12%), or null if <24h of history',
    nullable: true,
    example: 0.121,
  })
  day!: number | null;

  @ApiProperty({
    description: '7d-window annualised APY (ratio), or null if <7d of history',
    nullable: true,
    example: 0.118,
  })
  week!: number | null;

  @ApiProperty({
    description: '30d-window annualised APY (ratio), or null if <30d of history',
    nullable: true,
    example: 0.115,
  })
  month!: number | null;
}

/** One point on the earn time-series sparkline. */
export class EarnHistoryPointDto {
  @ApiProperty({
    description: 'Snapshot timestamp (ISO-8601)',
    example: '2026-06-03T12:00:00.000Z',
  })
  ts!: string;

  @ApiProperty({
    description: 'Book NAV at this point (USD float, e.g. 1.0042)',
    example: 1.0042,
  })
  bookNav!: number;

  @ApiProperty({
    description: 'stRWT→RWT rate at this point (float, e.g. 10.13)',
    example: 10.13,
  })
  strwtRate!: number;
}

/** Public earn-stats response. */
export class EarnStatsResponseDto {
  @ApiProperty({ description: 'Latest Book NAV (USD float)', example: 1.0042 })
  bookNav!: number;

  @ApiProperty({ description: 'Latest stRWT→RWT rate (float)', example: 10.13 })
  strwtRate!: number;

  @ApiProperty({ description: 'Latest TVL (USD float)', example: 1057.0 })
  tvl!: number;

  @ApiProperty({ type: EarnApyDto })
  apy!: EarnApyDto;

  @ApiProperty({
    type: [EarnHistoryPointDto],
    description:
      'Downsampled time-series (~30–60 points over the longest window) for the sparkline',
  })
  history!: EarnHistoryPointDto[];
}
