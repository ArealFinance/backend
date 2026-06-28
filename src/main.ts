/**
 * Application bootstrap.
 *
 * Hardening notes:
 *   - `helmet()` for security headers (CSP, HSTS, etc).
 *   - CORS allow-list pinned to known frontend origins; never `*`.
 *   - Global `ValidationPipe` with `whitelist + forbidNonWhitelisted` so
 *     unknown payload fields reject early (prevents mass-assignment).
 *   - Listens on `127.0.0.1` only — production exposure is via reverse proxy
 *     / Cloudflared, never direct internet binding.
 *   - `/metrics` runs on a SEPARATE Nest app on `127.0.0.1:9201` so the
 *     Prometheus scrape surface is never reachable through the public
 *     reverse-proxy / Cloudflared rule that fronts the main API.
 */
import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { ConfigService } from '@nestjs/config';

import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';
import { MetricsAppModule } from './modules/metrics/metrics-app.module.js';
import { MetricsService } from './modules/metrics/metrics.service.js';
import { RealtimeRedisIoAdapter } from './modules/realtime/redis-io.adapter.js';
import { RpcProxyOnlyModule } from './rpc-proxy-only.module.js';

/**
 * Production CORS allow-list. ONLY the public app + ops panel.
 *
 * `localhost:*` is intentionally absent — production deployments must not
 * accept cross-origin requests from a developer laptop, even if the laptop
 * is on the same network. Add new prod origins here and redeploy; a missing
 * entry surfaces as a CORS 4xx on the client, not a silent allow.
 */
const PROD_ALLOWED_ORIGINS = [
  // Public app. `areal.finance` is the canonical apex; `app.areal.finance`
  // and `www.areal.finance` redirect to it (Cloudflare-side) but the
  // browser still sends the pre-redirect origin on the initial XHR, so
  // both stay allow-listed while the migration settles.
  'https://areal.finance',
  'https://www.areal.finance',
  'https://app.areal.finance',
  // Earn app. `earn.areal.finance` is the canonical custom domain;
  // `earn-areal.pages.dev` is the Cloudflare Pages default domain (used for
  // testing before the custom domain is attached) — both stay allow-listed.
  'https://earn.areal.finance',
  'https://earn-areal.pages.dev',
  // Ops panel.
  'https://panel.areal.finance',
];

/**
 * Dev CORS allow-list — superset of prod so a dev container hitting prod
 * staging is fine, plus the two Vite dev-server ports.
 */
const DEV_ALLOWED_ORIGINS = [
  ...PROD_ALLOWED_ORIGINS,
  'http://localhost:5173',
  'http://localhost:5174',
];

/**
 * Slim bootstrap for the standalone RPC-proxy-only deployment
 * (`RPC_PROXY_ONLY=true`). Builds the app from `RpcProxyOnlyModule` — NO
 * TypeORM / Bull / Schedule / indexer / WS / metrics — so it runs as an
 * isolated mainnet RPC proxy without ever touching Postgres or Redis.
 *
 * Applies the SAME security posture as the full boot (helmet + the pinned CORS
 * allow-list + `127.0.0.1`-fronted listener) and the shared exception filter,
 * but deliberately OMITS:
 *   - the global whitelist `ValidationPipe` — the `POST /rpc` controller takes
 *     an UNTYPED body (a JSON-RPC payload may be a single object or a batch
 *     array with open-ended `params`) and validates it structurally in the
 *     service; a whitelist pipe would strip / reject valid RPC fields.
 *   - Swagger, the Redis WS adapter and the separate metrics app — none apply
 *     to a stateless proxy.
 */
async function bootstrapProxyOnly() {
  const app = await NestFactory.create<NestExpressApplication>(RpcProxyOnlyModule, {
    logger: ['log', 'error', 'warn'],
  });

  // Back the controller's body cap with an Express json-parser memory bound so
  // a huge payload can't be buffered into memory unbounded (Nest's default
  // ~100KB would silently disagree with a raised RPC_PROXY_MAX_BODY_BYTES).
  //
  // Layering, outermost first:
  //   1. The controller checks Content-Length against the EXACT cap and throws
  //      a clean `PayloadTooLargeException` (→ 413) BEFORE reading the body. A
  //      real client always sends Content-Length, so this is the path that
  //      produces the proper 413 for an oversized request.
  //   2. The parser limit below is the hard MEMORY bound for the pathological
  //      chunked / no-Content-Length case the controller can't pre-check. A
  //      body that trips the parser surfaces as a generic 500 via the shared
  //      filter (which only special-cases `HttpException`); that's acceptable
  //      for an abnormal client — the request is rejected and never reaches
  //      upstream, and memory stays bounded.
  // We set the parser bound generously above the cap so the controller's 413
  // (1) owns the normal oversized case, while (2) still caps memory.
  const maxBodyBytes = parseInt(process.env.RPC_PROXY_MAX_BODY_BYTES ?? '', 10);
  if (Number.isFinite(maxBodyBytes) && maxBodyBytes > 0) {
    app.useBodyParser('json', { limit: maxBodyBytes * 2 });
  }

  app.use(helmet());
  const isProduction = process.env.NODE_ENV === 'production';
  // `credentials: false` — `POST /rpc` is anonymous (no cookies / Authorization),
  // so the proxy never needs CORS credentials. Origins stay pinned to the same
  // allow-list as the full stack.
  app.enableCors({
    origin: isProduction ? PROD_ALLOWED_ORIGINS : DEV_ALLOWED_ORIGINS,
    credentials: false,
  });
  // Shared filter for a consistent error envelope; NO global ValidationPipe
  // (see doc comment above — it would mangle JSON-RPC batch bodies).
  app.useGlobalFilters(new AllExceptionsFilter());

  // Bind host: 0.0.0.0 inside the container so Docker port-mapping (which
  // routes from the host's 127.0.0.1 → container) can reach the listener.
  // Production locality comes from `127.0.0.1:<port>:<port>` in the compose
  // file. Default PORT 3012 keeps it off the full backend's 3010.
  const port = parseInt(process.env.PORT ?? '3012', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen(port, host);

  // eslint-disable-next-line no-console
  console.log(
    `Areal RPC proxy (proxy-only mode) listening on http://127.0.0.1:${port} (/rpc, /health)`,
  );
}

async function bootstrap() {
  // RPC-proxy-only branch: a lightweight, standalone Solana RPC proxy with no
  // DB / indexer / keeper / WS. Build the slim app and RETURN before any of the
  // full-stack wiring below runs.
  if (process.env.RPC_PROXY_ONLY === 'true') {
    await bootstrapProxyOnly();
    return;
  }

  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'error', 'warn', 'debug', 'verbose'],
  });

  app.use(helmet());
  const isProduction = process.env.NODE_ENV === 'production';
  app.enableCors({
    origin: isProduction ? PROD_ALLOWED_ORIGINS : DEV_ALLOWED_ORIGINS,
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Areal Backend API')
    .setDescription('Indexer + REST API for the Areal protocol (5 on-chain programs).')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  // -- Socket.IO adapter (Phase 12.3.1) ----------------------------------
  // Wire BEFORE `app.listen` so the gateway picks up the adapter at the
  // moment the underlying HTTP server initialises Socket.IO. The adapter
  // fan-outs emits across replicas via Redis pub/sub — without it, a cron
  // firing on the worker replica only reaches sockets on that replica.
  // Single-node deploys still benefit (consistent code path; one extra
  // round trip per emit is negligible).
  const wsConfig = app.get(ConfigService);
  const wsRedisUrl = wsConfig.get<string>('redis.url') ?? 'redis://127.0.0.1:6379/0';
  const wsAdapter = new RealtimeRedisIoAdapter(app);
  await wsAdapter.connectToRedis(wsRedisUrl);
  app.useWebSocketAdapter(wsAdapter);

  // Bind host: in container, must be 0.0.0.0 so Docker port-mapping
  // (which routes from host's 127.0.0.1 → container) can reach the listener.
  // Container's loopback is unreachable from outside the container, so
  // production security comes from `127.0.0.1:3010:3010` in compose
  // (host-side bind to loopback only).
  // For bare-metal / non-container dev: HOST=127.0.0.1 explicitly restricts.
  const port = parseInt(process.env.PORT ?? '3010', 10);
  const host = process.env.HOST ?? '0.0.0.0';
  await app.listen(port, host);

  // -- separate metrics listener (localhost-only) -------------------------
  // Resolve the main app's MetricsService and hand it to a second Nest app
  // bound to 127.0.0.1:9201. That second app exposes `/metrics` and nothing
  // else — no auth, no swagger, no indexer. The shared instance keeps
  // counters/gauges in one process-wide registry; the public API on :3010
  // never serves `/metrics`.
  const sharedMetrics = app.get(MetricsService);
  const metricsApp = await NestFactory.create(MetricsAppModule.forRoot(sharedMetrics), {
    logger: ['log', 'error', 'warn'],
  });
  // Same reasoning as the main listener: bind 0.0.0.0 so Docker port-mapping
  // works; host-side compose bind `127.0.0.1:9201:9201` enforces locality.
  const metricsPort = parseInt(process.env.METRICS_PORT ?? '9201', 10);
  const metricsHost = process.env.METRICS_HOST ?? '0.0.0.0';
  await metricsApp.listen(metricsPort, metricsHost);

  // eslint-disable-next-line no-console
  console.log(`Areal backend listening on http://127.0.0.1:${port} (docs: /api/docs)`);
  // eslint-disable-next-line no-console
  console.log(`Metrics scrape on http://127.0.0.1:${metricsPort}/metrics (localhost-only)`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed', err);
  process.exit(1);
});
