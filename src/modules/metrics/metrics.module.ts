import { Global, Module } from '@nestjs/common';

import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';

/**
 * Global so other modules can `@Inject(MetricsService)` without re-importing.
 * Counters/gauges live in the same registry across the process — sharing
 * the service is the cleanest way to keep that contract.
 */
@Global()
@Module({
  controllers: [MetricsController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class MetricsModule {}
