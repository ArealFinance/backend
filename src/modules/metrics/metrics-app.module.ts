import { DynamicModule, Module } from '@nestjs/common';

import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';

/**
 * Standalone Nest module hosting **only** the `/metrics` Prometheus scrape
 * endpoint. Bootstrapped as a second `NestFactory.create(...)` app inside
 * `main.ts` and bound to `127.0.0.1:9201` so the metrics surface is never
 * exposed to the public reverse-proxy / Cloudflared tunnel that fronts the
 * main API.
 *
 * Why a separate Nest app instead of just a route on the main one:
 *   - The main API listens on `0.0.0.0` (or wherever the prod proxy points)
 *     and the only way to keep `/metrics` off that surface is a separate
 *     listener bound to `127.0.0.1`.
 *   - Two apps means two DI contexts, but counters/gauges live in the main
 *     app's `MetricsService` instance — it's the one every feature module
 *     calls into. We pass that exact instance into this module via
 *     `forRoot(sharedService)` so the scrape returns live data instead of
 *     a fresh, empty registry.
 */
@Module({})
export class MetricsAppModule {
  /**
   * Build the metrics-only DI context with the main app's `MetricsService`
   * instance injected as the provider value. Any controller resolving
   * `MetricsService` here gets the SAME object that every feature module in
   * the main app increments — the registry is shared by reference.
   */
  static forRoot(shared: MetricsService): DynamicModule {
    return {
      module: MetricsAppModule,
      controllers: [MetricsController],
      providers: [
        {
          provide: MetricsService,
          useValue: shared,
        },
      ],
      exports: [MetricsService],
    };
  }
}
