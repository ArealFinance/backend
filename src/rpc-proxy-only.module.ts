import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';

import { RealIpThrottlerGuard } from './common/net/real-ip-throttler.guard.js';
import configuration from './config/configuration.js';
import { ProxyHealthController } from './modules/rpc-proxy/proxy-health.controller.js';
import { RpcProxyModule } from './modules/rpc-proxy/rpc-proxy.module.js';

/**
 * Slim root module for the standalone RPC-proxy-only deployment
 * (`RPC_PROXY_ONLY=true`, wired in `main.ts`).
 *
 * WHY THIS EXISTS: the full `AppModule` boots TypeORM, Bull, Schedule, the
 * indexer, markets, the earn keeper, the realtime WS gateway and a second
 * metrics app — all of which need Postgres + Redis and are devnet-indexer
 * concerns. To run `POST /rpc` as an isolated mainnet microservice (hiding the
 * Helius key from the client bundle) none of that is needed. This module wires
 * ONLY what the proxy depends on:
 *
 *   - ConfigModule  → `solana.rpcUrl` (from `RPC_URL_<CLUSTER>`) + `rpcProxy.*`
 *                     tunables. `configuration` skips the JWT fail-fast in
 *                     proxy-only mode (no auth here).
 *   - ThrottlerModule → same default policy as AppModule (60 req/min) so the
 *                     proxy's per-route `@Throttle` override behaves identically.
 *   - RpcProxyModule  → the `POST /rpc` controller + service.
 *   - ProxyHealthController → flat `GET /health` so deploy probes pass WITHOUT
 *                     a DB / RPC dependency (the full HealthModule needs both).
 *   - RealIpThrottlerGuard as global APP_GUARD → real-client-IP rate limiting,
 *                     keyed identically to the full stack.
 *
 * Deliberately ABSENT: TypeOrmModule, BullModule, ScheduleModule, IndexerModule,
 * MarketsModule, EarnKeeperModule, RealtimeModule, the metrics app. The slim app
 * therefore boots with NO Postgres / Redis connection.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env.local', '.env'],
    }),
    // Same default policy as AppModule (ttl 60s / limit 60). The RPC proxy's
    // per-route `@Throttle({ default: { ... } })` overrides this with its own
    // (env-tunable) limit; keeping the named `default` policy here means that
    // override resolves identically to the full stack.
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 60,
      },
    ]),
    RpcProxyModule,
  ],
  controllers: [ProxyHealthController],
  providers: [
    // Real-client-IP throttler (not the stock guard) so behind Cloudflared /
    // nginx the per-IP limit keys on the originating client, not the single
    // proxy-hop IP. Identical wiring to AppModule.
    { provide: APP_GUARD, useClass: RealIpThrottlerGuard },
  ],
})
export class RpcProxyOnlyModule {}
