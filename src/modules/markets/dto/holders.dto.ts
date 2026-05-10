import { ApiProperty } from '@nestjs/swagger';

/**
 * Response shape for `GET /markets/tokens/:mint/holders`.
 *
 * `count` is the number of unique SPL token accounts holding a non-zero
 * balance for the mint at the moment the upstream RPC was queried. The
 * value is cached in Redis for 5 minutes; `source` discriminates fresh
 * RPC reads from cache hits so the client / dashboards can reason about
 * staleness.
 */
export class TokenHoldersResponseDto {
  @ApiProperty({ description: 'SPL mint pubkey (base58)' })
  mint!: string;

  @ApiProperty({ description: 'Number of token accounts with amount > 0' })
  count!: number;

  @ApiProperty({
    description: 'ISO 8601 timestamp at backend RPC fetch (frozen across cache hits)',
  })
  updatedAt!: string;

  @ApiProperty({
    enum: ['rpc', 'cache'],
    description: 'Whether this response was served from a fresh RPC call or Redis cache',
  })
  source!: 'rpc' | 'cache';
}
