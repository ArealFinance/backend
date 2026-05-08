import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';

import { CurrentWallet } from '../../common/decorators/current-wallet.decorator.js';
import { AuthService } from './auth.service.js';
import { AuthResponseDto } from './dto/auth-response.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { RefreshDto } from './dto/refresh.dto.js';
import { JwtAuthGuard } from './guards/jwt-auth.guard.js';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Tight per-IP cap on `/auth/login` — wallet-signature verification is the
  // single most expensive route (ed25519 + DB upsert + JWT mint) and the
  // attractive target for credential-stuffing-style probes. 5/min is more
  // than any honest client needs (failed sigs typically retry a few times
  // before the user gives up).
  @Post('login')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Wallet-signature login → JWT' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Signature, timestamp, or message-binding invalid' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded — slow down' })
  login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.login(dto);
  }

  // Refresh is cheap server-side but a stolen-token bot would burn through
  // its rotation chain quickly — 10/min/IP gives legit clients plenty of
  // headroom (refresh runs ~1/hour in practice) while bounding abuse.
  @Post('refresh')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate refresh token → fresh JWT pair' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  @ApiResponse({ status: 401, description: 'Refresh token invalid, expired, or revoked' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded — slow down' })
  refresh(@Body() dto: RefreshDto): Promise<AuthResponseDto> {
    return this.authService.refresh(dto.refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Echoes the authenticated wallet — handy for client probes' })
  me(@CurrentWallet() wallet: string): { wallet: string } {
    return { wallet };
  }
}
