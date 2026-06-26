import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBody, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';

import { JsonRpcRequestDto } from './dto/json-rpc.dto.js';
import {
  DEFAULT_RPC_PROXY_RATE_LIMIT,
  DEFAULT_RPC_PROXY_RATE_TTL_MS,
} from './rpc-proxy.constants.js';
import { RpcProxyService } from './rpc-proxy.service.js';

/**
 * Public JSON-RPC proxy.
 *
 * Route: `POST /rpc` (the backend sets no global prefix — see `main.ts` — so
 * the app calls `${FAUCET_API_BASE}/rpc`). The frontend points its Solana
 * `Connection` / RPC client at this URL instead of embedding a Helius key.
 *
 * The body is accepted UNTYPED (`@Body() body: unknown`): a JSON-RPC payload
 * may be a single object or a batch array and `params` is open-ended, so the
 * global whitelist ValidationPipe must not touch it. All validation —
 * envelope shape + method allow-list — happens in `RpcProxyService`.
 *
 * Abuse controls:
 *   - Per-IP rate limit via `@Throttle` (default ~90 req/min/IP, env-tunable).
 *   - Body-size cap checked from Content-Length before reading the body.
 *   - CORS is enforced globally in `main.ts` (Areal origins only).
 *   - Method allow-list + upstream timeout live in the service.
 */
@ApiTags('rpc')
@Controller('rpc')
export class RpcProxyController {
  private readonly maxBodyBytes: number;

  constructor(
    private readonly service: RpcProxyService,
    private readonly config: ConfigService,
  ) {
    this.maxBodyBytes = this.config.get<number>('rpcProxy.maxBodyBytes') ?? 100_000;
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  // Per-IP rate limit, read from config. Overrides the 60 req/min global
  // default with the proxy-specific value (default 90). The named key `default`
  // matches the global throttler definition registered in AppModule.
  @Throttle({
    default: {
      limit: rpcProxyLimit(),
      ttl: rpcProxyTtl(),
    },
  })
  @ApiOperation({
    summary: 'JSON-RPC proxy to the server-side Solana RPC (allow-listed methods only)',
  })
  @ApiBody({ type: JsonRpcRequestDto, description: 'Single JSON-RPC request or a batch array.' })
  @ApiResponse({ status: 200, description: 'Upstream JSON-RPC response (or JSON-RPC error body).' })
  @ApiResponse({ status: 400, description: 'Malformed request or disallowed method.' })
  @ApiResponse({ status: 413, description: 'Request body exceeds the configured cap.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded for this IP.' })
  async proxy(@Body() body: unknown, @Req() req: Request, @Res() res: Response): Promise<void> {
    // Body-size cap. Express's json() parser already enforces a limit, but we
    // re-check from Content-Length so the cap is owned here and configurable,
    // and so an oversized payload is rejected with a clear 413 rather than a
    // generic parser error.
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (Number.isFinite(contentLength) && contentLength > this.maxBodyBytes) {
      throw new PayloadTooLargeException(`Request body exceeds ${this.maxBodyBytes} bytes`);
    }

    const result = await this.service.handle(body);
    res.status(result.status).json(result.body);
  }
}

/**
 * Throttle decorator options are evaluated at class-definition time, so they
 * can't read ConfigService directly. These helpers read the env once (with the
 * same defaults as `configuration.ts`) so the decorator and the config stay in
 * sync. ConfigService remains the source of truth for the body cap / timeout
 * (read at runtime in the controller/service); only the throttle numbers need
 * this static bridge.
 */
function rpcProxyLimit(): number {
  const parsed = parseInt(process.env.RPC_PROXY_RATE_LIMIT ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RPC_PROXY_RATE_LIMIT;
}

function rpcProxyTtl(): number {
  const parsed = parseInt(process.env.RPC_PROXY_RATE_TTL_MS ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_RPC_PROXY_RATE_TTL_MS;
}
