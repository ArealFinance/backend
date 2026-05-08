import { Controller, Get, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { ListTransactionsDto } from './dto/list-transactions.dto.js';
import { ListTransactionsResponseDto } from './dto/transaction-row.dto.js';
import { TransactionsService } from './transactions.service.js';

/**
 * Public-read activity feed.
 *
 * No JWT — `wallet` is required in the query string and the response only
 * contains data already derived from on-chain events. The 60 req/min global
 * throttler is sufficient; per-route tightening lives in the auth module
 * for the expensive routes.
 */
@ApiTags('transactions')
@Controller('transactions')
export class TransactionsController {
  constructor(private readonly service: TransactionsService) {}

  @Get()
  @ApiOperation({ summary: 'List transactions for a wallet (paginated)' })
  @ApiOkResponse({ type: ListTransactionsResponseDto })
  list(@Query() query: ListTransactionsDto): Promise<ListTransactionsResponseDto> {
    return this.service.list(query);
  }
}
