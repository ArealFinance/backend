import { Controller, Get, Header } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';

import { MetricsService } from './metrics.service.js';

/**
 * Prometheus scrape endpoint.
 *
 * Excluded from Swagger because the response is `text/plain; version=0.0.4`
 * (Prometheus exposition format), not JSON. Bound to the same port as the
 * REST API for now — operators can put it behind a separate firewall rule
 * via reverse-proxy ACL when scraping from outside the network.
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
