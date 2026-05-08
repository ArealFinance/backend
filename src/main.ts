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
 */
import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';

import { AppModule } from './app.module.js';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter.js';

/**
 * Production CORS allow-list. ONLY the public app + ops panel.
 *
 * `localhost:*` is intentionally absent — production deployments must not
 * accept cross-origin requests from a developer laptop, even if the laptop
 * is on the same network. Add new prod origins here and redeploy; a missing
 * entry surfaces as a CORS 4xx on the client, not a silent allow.
 */
const PROD_ALLOWED_ORIGINS = ['https://app.areal.finance', 'https://panel.areal.finance'];

/**
 * Dev CORS allow-list — superset of prod so a dev container hitting prod
 * staging is fine, plus the two Vite dev-server ports.
 */
const DEV_ALLOWED_ORIGINS = [
  ...PROD_ALLOWED_ORIGINS,
  'http://localhost:5173',
  'http://localhost:5174',
];

async function bootstrap() {
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

  const port = parseInt(process.env.PORT ?? '3010', 10);
  await app.listen(port, '127.0.0.1');

  // eslint-disable-next-line no-console
  console.log(`Areal backend listening on http://127.0.0.1:${port} (docs: /api/docs)`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Bootstrap failed', err);
  process.exit(1);
});
