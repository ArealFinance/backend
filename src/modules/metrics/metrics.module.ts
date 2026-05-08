import { Global, Module } from '@nestjs/common';

import { MetricsService } from './metrics.service.js';

/**
 * Global so other modules can `@Inject(MetricsService)` without re-importing.
 * Counters/gauges live in the same registry across the process — sharing
 * the service is the cleanest way to keep that contract.
 *
 * NOTE: deliberately does NOT register `MetricsController`. The Prometheus
 * scrape endpoint lives on a separate Nest app (`MetricsAppModule`) bound
 * to `127.0.0.1:9201` so the metrics surface never reaches the public
 * reverse-proxy / Cloudflared tunnel that fronts the main API. See
 * `main.ts` for the dual-bootstrap wiring and the shared-instance hand-off
 * that lets the localhost listener scrape the live counters.
 */
@Global()
@Module({
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
