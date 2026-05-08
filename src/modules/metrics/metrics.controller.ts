import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { MetricsService } from './metrics.service.js';

/**
 * Prometheus scrape endpoint.
 *
 * Excluded from Swagger because the response is `text/plain; version=0.0.4`
 * (Prometheus exposition format), not JSON. Mounted ONLY on the standalone
 * `MetricsAppModule` Nest app bound to `127.0.0.1:9201` (see `main.ts`) —
 * never registered on the public REST surface, so the metrics surface can
 * never reach the public reverse-proxy / Cloudflared tunnel.
 */
@ApiExcludeController()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
