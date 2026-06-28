import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

/**
 * Minimal liveness probe for the RPC-proxy-only deployment.
 *
 * The full-stack `HealthController` (modules/health) probes Postgres + RPC and
 * pulls in `IndexerModule` / `DataSource` — neither of which exists in the slim
 * proxy-only boot. This controller is intentionally dependency-free: it answers
 * a flat `200 { status: 'ok', mode: 'rpc-proxy-only' }` so deploy / load-balancer
 * health checks pass without booting any DB or RPC client.
 *
 * It deliberately does NOT probe the upstream RPC — that would spend our paid
 * RPC quota on every health poll. Upstream reachability surfaces naturally via
 * the `POST /rpc` path when real traffic flows.
 */
@ApiTags('health')
@Controller('health')
export class ProxyHealthController {
  @Get()
  @ApiOperation({ summary: 'Liveness probe (RPC-proxy-only mode)' })
  @ApiResponse({ status: 200, description: 'Service is up.' })
  check(): { status: 'ok'; mode: 'rpc-proxy-only' } {
    return { status: 'ok', mode: 'rpc-proxy-only' };
  }
}
