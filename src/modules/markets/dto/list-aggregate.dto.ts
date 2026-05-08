import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Query parameters for `GET /markets/pools/:pool/aggregate`.
 *
 * `days` selects the most-recent N daily aggregate rows (UTC day buckets),
 * default 7, capped at 90. The 90-day cap matches the typical "trailing
 * 90d APY" UI affordance and bounds the query response size.
 */
export class ListAggregateDto {
  @ApiPropertyOptional({
    description: 'How many trailing days to include (UTC day buckets).',
    default: 7,
    minimum: 1,
    maximum: 90,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;
}
