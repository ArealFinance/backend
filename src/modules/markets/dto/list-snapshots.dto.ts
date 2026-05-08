import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Query parameters for `GET /markets/pools/:pool/snapshots`.
 *
 * `from` / `to` are unix-second cutoffs against `block_time`. Limit-only
 * pagination — there is no cursor; charts pull the latest N points and
 * fetch wider history with `from=<earlier>`. Capped at 200 to bound the
 * query plan; daily/weekly charts that need more should use
 * `daily_pool_aggregates` instead.
 *
 * `pool` is validated by the controller via the path-level base58 regex
 * (mirrors `PortfolioController` style), not here — so the DTO stays
 * a pure query-shape concern.
 */
export class ListSnapshotsDto {
  @ApiPropertyOptional({
    description: 'Lower bound (inclusive) on block_time, unix seconds.',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  from?: number;

  @ApiPropertyOptional({
    description: 'Upper bound (inclusive) on block_time, unix seconds.',
    minimum: 0,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  to?: number;

  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
