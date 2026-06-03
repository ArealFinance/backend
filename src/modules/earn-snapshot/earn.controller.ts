import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { EarnStatsResponseDto } from './dto/earn-stats.dto.js';
import { EarnStatsService } from './earn-stats.service.js';

/**
 * Public-read earn endpoints.
 *
 * No JWT — every byte returned is derived from chain state already visible to
 * anyone running an indexer. Same CORS allow-list as the rest of the API
 * (configured globally in `main.ts`, already includes the earn origins).
 *
 * Throttled modestly below the 60 req/min global default: this endpoint loads
 * up to ~30 days of snapshots and computes APY in-memory, so 30 req/min/IP is
 * plenty for legitimate dashboards while discouraging scraping.
 */
@ApiTags('earn')
@Controller('earn')
export class EarnController {
  constructor(private readonly stats: EarnStatsService) {}

  @Get('stats')
  @ApiOperation({
    summary: 'Earn vault stats — Book NAV, stRWT rate, TVL, honest APY, history',
  })
  @ApiOkResponse({ type: EarnStatsResponseDto })
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  getStats(): Promise<EarnStatsResponseDto> {
    return this.stats.getStats();
  }
}
