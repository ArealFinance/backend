import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { FaucetClaimResponseDto } from './dto/faucet-claim-response.dto.js';
import { FaucetClaimDto } from './dto/faucet-claim.dto.js';
import { FaucetRwtClaimDto } from './dto/faucet-rwt-claim.dto.js';
import { FaucetEarnUsdcClaimDto } from './dto/faucet-earn-usdc-claim.dto.js';
import { DevnetOrLocalnetGuard, LocalnetOnlyGuard } from './faucet.guard.js';
import { FaucetService } from './faucet.service.js';
import { RwtFaucetService } from './rwt-faucet.service.js';
import { EarnUsdcFaucetService } from './earn-usdc-faucet.service.js';

/**
 * Faucet endpoints (localnet USDC, devnet/localnet RWT, devnet/localnet earn-USDC).
 *
 * Each route is hard-gated by its own cluster guard — on disallowed
 * clusters the route 404s before any business logic runs. The throttle
 * bound (5/min/IP) is a defense-in-depth measure on top of the per-wallet
 * 24h limit applied inside each service.
 */
@ApiTags('faucet')
@Controller('faucet')
export class FaucetController {
  constructor(
    private readonly faucetService: FaucetService,
    private readonly rwtFaucetService: RwtFaucetService,
    private readonly earnUsdcFaucetService: EarnUsdcFaucetService,
  ) {}

  @Post('usdc')
  @UseGuards(LocalnetOnlyGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Drip test-USDC to a wallet on localnet (one claim per wallet per 24h).',
  })
  @ApiResponse({ status: 200, type: FaucetClaimResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error — invalid wallet or amount.' })
  @ApiResponse({ status: 404, description: 'Endpoint disabled — not running on localnet.' })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded — either the per-IP window or the per-wallet 24h cap. ' +
      'Body includes `retryAfterSec`.',
  })
  claim(@Body() dto: FaucetClaimDto): Promise<FaucetClaimResponseDto> {
    return this.faucetService.claim(dto.wallet, dto.amount);
  }

  @Post('rwt')
  @UseGuards(DevnetOrLocalnetGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Drip test-RWT to a wallet on devnet/localnet (one claim per wallet per 24h, 100 RWT default).',
  })
  @ApiResponse({ status: 200, type: FaucetClaimResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error — invalid wallet or amount.' })
  @ApiResponse({
    status: 404,
    description: 'Endpoint disabled — not running on devnet or localnet.',
  })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded — either the per-IP window or the per-wallet 24h cap. ' +
      'Body includes `retryAfterSec`.',
  })
  claimRwt(@Body() dto: FaucetRwtClaimDto): Promise<FaucetClaimResponseDto> {
    return this.rwtFaucetService.claimRwt(dto.wallet, dto.amount);
  }

  @Post('earn-usdc')
  @UseGuards(DevnetOrLocalnetGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Drip test earn-USDC to a wallet on devnet/localnet (one claim per wallet per 24h, 100 USDC default).',
  })
  @ApiResponse({ status: 200, type: FaucetClaimResponseDto })
  @ApiResponse({ status: 400, description: 'Validation error — invalid wallet or amount.' })
  @ApiResponse({
    status: 404,
    description: 'Endpoint disabled — not running on devnet or localnet.',
  })
  @ApiResponse({
    status: 429,
    description:
      'Rate limit exceeded — either the per-IP window or the per-wallet 24h cap. ' +
      'Body includes `retryAfterSec`.',
  })
  claimEarnUsdc(@Body() dto: FaucetEarnUsdcClaimDto): Promise<FaucetClaimResponseDto> {
    return this.earnUsdcFaucetService.claimEarnUsdc(dto.wallet, dto.amount);
  }
}
