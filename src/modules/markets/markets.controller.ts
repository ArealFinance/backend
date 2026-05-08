import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ListAggregateResponseDto } from './dto/daily-aggregate.dto.js';
import { ListAggregateDto } from './dto/list-aggregate.dto.js';
import { ListSnapshotsDto } from './dto/list-snapshots.dto.js';
import { ProtocolSummaryDto } from './dto/protocol-summary.dto.js';
import { ListSnapshotsResponseDto } from './dto/snapshot-row.dto.js';
import { MarketsService } from './markets.service.js';

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Public-read markets endpoints.
 *
 * No JWT — every byte returned here is derived from chain state already
 * visible to anyone running an indexer. The 60 req/min global throttler
 * is sufficient.
 *
 * URL shape mirrors `/portfolio/:wallet/...` for consistency: pool key
 * lives in the path so caches can key on it without parsing the query.
 */
@ApiTags('markets')
@Controller('markets')
export class MarketsController {
  constructor(private readonly service: MarketsService) {}

  @Get('pools/:pool/snapshots')
  @ApiOperation({ summary: 'Per-pool TVL/reserve snapshots (time-series, latest-first)' })
  @ApiOkResponse({ type: ListSnapshotsResponseDto })
  listSnapshots(
    @Param('pool') pool: string,
    @Query() query: ListSnapshotsDto,
  ): Promise<ListSnapshotsResponseDto> {
    requirePubkey(pool, 'pool');
    return this.service.listSnapshots(pool, query);
  }

  @Get('pools/:pool/aggregate')
  @ApiOperation({ summary: 'Per-pool daily aggregate (volume / fees / APY) — last N days' })
  @ApiOkResponse({ type: ListAggregateResponseDto })
  listAggregate(
    @Param('pool') pool: string,
    @Query() query: ListAggregateDto,
  ): Promise<ListAggregateResponseDto> {
    requirePubkey(pool, 'pool');
    return this.service.listAggregate(pool, query);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Protocol-wide summary (singleton)' })
  @ApiOkResponse({ type: ProtocolSummaryDto })
  getSummary(): Promise<ProtocolSummaryDto> {
    return this.service.getSummary();
  }
}

function requirePubkey(value: string, field: string): void {
  if (typeof value !== 'string' || !PUBKEY_RE.test(value)) {
    throw new BadRequestException(`${field} must be a base58 pubkey`);
  }
}
