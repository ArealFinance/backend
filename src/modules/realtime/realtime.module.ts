import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module.js';
import { HandshakeThrottleService } from './handshake-throttle.js';
import { RealtimeGateway } from './realtime.gateway.js';
import { RealtimeService } from './realtime.service.js';

/**
 * Phase 12.3.1 realtime substrate.
 *
 * Imports `AuthModule` for `JwtService` (used at handshake to verify the
 * Bearer token / `auth.token` payload). `MetricsService` is provided by
 * the global `MetricsModule` so we don't re-import it here.
 *
 * Exports `RealtimeService` so emit-side callers (`MarketsAggregatorService`,
 * `IndexerConsumer` via `ProjectionsModule`) can fan out without learning
 * about Socket.IO room naming.
 *
 * The gateway is provided here but not exported — only the emit facade
 * leaves the module boundary, which keeps the `server` instance an
 * implementation detail.
 *
 * `HandshakeThrottleService` is exported in case other gateways ever need
 * the same per-IP cap; today only `RealtimeGateway` consumes it.
 */
@Module({
  imports: [AuthModule],
  providers: [RealtimeGateway, RealtimeService, HandshakeThrottleService],
  exports: [RealtimeService, HandshakeThrottleService],
})
export class RealtimeModule {}
