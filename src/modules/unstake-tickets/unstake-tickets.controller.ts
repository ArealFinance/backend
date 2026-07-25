import { BadRequestException, Controller, Get, Header, Param } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PublicKey } from '@solana/web3.js';

import { UnstakeTicketsResponseDto } from './dto/unstake-tickets.dto.js';
import { UnstakeTicketsService } from './unstake-tickets.service.js';

/**
 * Public read-only mainnet unstake-ticket endpoint.
 *
 * `wallet` is deliberately the only accepted input. The program ID, RPC
 * endpoint and account filters stay server-side, so this route cannot be used
 * as a general-purpose Solana RPC proxy.
 */
@ApiTags('earn')
@Controller('earn')
export class UnstakeTicketsController {
  constructor(private readonly tickets: UnstakeTicketsService) {}

  @Get('wallets/:wallet/unstake-tickets')
  @ApiOperation({ summary: 'Pending mainnet staking unstake tickets for a wallet' })
  @ApiOkResponse({ type: UnstakeTicketsResponseDto })
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  @Header('Cache-Control', 'no-store')
  list(@Param('wallet') wallet: string): Promise<UnstakeTicketsResponseDto> {
    return this.tickets.listForWallet(requirePublicKey(wallet));
  }
}

function requirePublicKey(value: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestException('wallet must be a base58 pubkey');
  }

  try {
    return new PublicKey(value).toBase58();
  } catch {
    // Do not return web3.js parser details or echo the submitted value.
    throw new BadRequestException('wallet must be a base58 pubkey');
  }
}
