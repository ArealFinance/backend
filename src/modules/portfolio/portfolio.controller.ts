import { BadRequestException, Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ListClaimsDto, ListClaimsResponseDto } from './dto/list-claims.dto.js';
import { ListLpPositionsDto, ListLpPositionsResponseDto } from './dto/list-lp-positions.dto.js';
import { PortfolioService } from './portfolio.service.js';

const PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Public-read portfolio history.
 *
 * The wallet is taken from the URL path (`/portfolio/:wallet/...`) — same
 * format as `/transactions?wallet=`. Path-style routing keeps the cache key
 * stable across query orderings and matches the SDK's portfolio module.
 */
@ApiTags('portfolio')
@Controller('portfolio')
export class PortfolioController {
  constructor(private readonly service: PortfolioService) {}

  @Get(':wallet/claims')
  @ApiOperation({ summary: 'Per-wallet claim history (paginated)' })
  @ApiOkResponse({ type: ListClaimsResponseDto })
  listClaims(
    @Param('wallet') wallet: string,
    @Query() query: ListClaimsDto,
  ): Promise<ListClaimsResponseDto> {
    requirePubkey(wallet, 'wallet');
    return this.service.listClaims(wallet, query);
  }

  @Get(':wallet/lp-positions')
  @ApiOperation({ summary: 'Per-wallet LP-position history (paginated)' })
  @ApiOkResponse({ type: ListLpPositionsResponseDto })
  listLpPositions(
    @Param('wallet') wallet: string,
    @Query() query: ListLpPositionsDto,
  ): Promise<ListLpPositionsResponseDto> {
    requirePubkey(wallet, 'wallet');
    return this.service.listLpPositions(wallet, query);
  }
}

function requirePubkey(value: string, field: string): void {
  if (typeof value !== 'string' || !PUBKEY_RE.test(value)) {
    throw new BadRequestException(`${field} must be a base58 pubkey`);
  }
}
