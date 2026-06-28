import 'reflect-metadata';

import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { describe, expect, it } from 'vitest';

import { RealIpThrottlerGuard } from './common/net/real-ip-throttler.guard.js';
import { ProxyHealthController } from './modules/rpc-proxy/proxy-health.controller.js';
import { RpcProxyController } from './modules/rpc-proxy/rpc-proxy.controller.js';
import { RpcProxyModule } from './modules/rpc-proxy/rpc-proxy.module.js';
import { RpcProxyService } from './modules/rpc-proxy/rpc-proxy.service.js';
import { RpcProxyOnlyModule } from './rpc-proxy-only.module.js';

/**
 * Slim-boot composition guardrail (architect note #3).
 *
 * GOAL: turn a future silent divergence into a CI failure. If someone injects a
 * DB `Repository<T>` / Bull queue / other heavy provider into `RpcProxyService`
 * (or pulls a DB/Redis module into the slim graph), the standalone proxy boot
 * would fail at `NestFactory.create` in production while the full `AppModule`
 * still works — exactly the kind of break that ships unnoticed.
 *
 * WHY METADATA, NOT `Test.createTestingModule(...).compile()`: this repo runs
 * Vitest on esbuild with NO `emitDecoratorMetadata`, so reflective constructor
 * DI of framework providers (e.g. `ConfigService` → `RpcProxyService`) isn't
 * resolvable in the test bed — every other spec here constructs such services
 * directly rather than via the Nest injector. So we assert the slim module's
 * Nest metadata instead: its `imports` are EXACTLY the proxy stack (Config +
 * Throttler + RpcProxyModule) with NO heavy module, its controllers/providers
 * are the proxy + health set, and the proxy module's own surface is unchanged.
 * The real wiring is proven separately by the manual smoke boot of `main.ts`.
 */
/** Resolve an import entry to its module class. Handles three shapes: a plain
 *  module class, a `DynamicModule` (`{ module, ... }`), and the `Promise<...>`
 *  that `ConfigModule.forRoot` / async `forRootAsync` return in this Nest
 *  version. */
async function resolveImportedModule(entry: unknown): Promise<unknown> {
  const resolved = await entry; // no-op for non-thenables
  if (typeof resolved === 'object' && resolved !== null && 'module' in resolved) {
    return (resolved as { module: unknown }).module;
  }
  return resolved;
}

describe('RpcProxyOnlyModule (slim-boot composition)', () => {
  const imports = (Reflect.getMetadata('imports', RpcProxyOnlyModule) ?? []) as unknown[];
  const controllers = (Reflect.getMetadata('controllers', RpcProxyOnlyModule) ?? []) as unknown[];
  const providers = (Reflect.getMetadata('providers', RpcProxyOnlyModule) ?? []) as unknown[];

  it('imports ONLY the proxy stack (Config + Throttler + RpcProxyModule)', async () => {
    const importedModules = await Promise.all(imports.map(resolveImportedModule));
    expect(importedModules).toContain(ConfigModule);
    expect(importedModules).toContain(ThrottlerModule);
    expect(importedModules).toContain(RpcProxyModule);
    // Exactly three imports — a new heavy module (TypeOrm / Bull / Schedule /
    // Indexer / Realtime / Markets / EarnKeeper) added here trips this.
    expect(imports).toHaveLength(3);
  });

  it('does NOT pull any DB / Redis / scheduler / indexer module into the slim graph', async () => {
    const importedModules = await Promise.all(imports.map(resolveImportedModule));
    const names = importedModules.map((m) =>
      typeof m === 'function' ? m.name : String((m as { name?: string })?.name ?? ''),
    );
    const forbidden = [
      'TypeOrmModule',
      'BullModule',
      'ScheduleModule',
      'IndexerModule',
      'RealtimeModule',
      'MarketsModule',
      'EarnKeeperModule',
      'EarnSnapshotModule',
      'AuthModule',
      'MetricsModule',
    ];
    for (const name of forbidden) {
      expect(names).not.toContain(name);
    }
  });

  it('declares the proxy health controller and registers the real-IP throttler guard', () => {
    expect(controllers).toContain(ProxyHealthController);
    // RealIpThrottlerGuard is wired as the global APP_GUARD (same as AppModule)
    // so the per-IP rate limit keys on the real client IP, not the proxy hop.
    const appGuard = providers.find(
      (p) =>
        typeof p === 'object' && p !== null && (p as { provide?: unknown }).provide === APP_GUARD,
    ) as { useClass?: unknown } | undefined;
    expect(appGuard).toBeDefined();
    expect(appGuard?.useClass).toBe(RealIpThrottlerGuard);
  });

  it('keeps the RpcProxyModule surface unchanged (controller + service only)', () => {
    // If RpcProxyService grows a heavy dependency, that's where a real
    // production slim-boot break would originate — assert the module still
    // exposes exactly the proxy controller + service so a structural change
    // (e.g. importing TypeOrmModule.forFeature here) is visible.
    const proxyControllers = (Reflect.getMetadata('controllers', RpcProxyModule) ??
      []) as unknown[];
    const proxyProviders = (Reflect.getMetadata('providers', RpcProxyModule) ?? []) as unknown[];
    const proxyImports = (Reflect.getMetadata('imports', RpcProxyModule) ?? []) as unknown[];
    expect(proxyControllers).toEqual([RpcProxyController]);
    expect(proxyProviders).toEqual([RpcProxyService]);
    // The proxy module must stay self-contained — no imports of its own (it
    // rides the global ConfigModule + app-wide ThrottlerGuard).
    expect(proxyImports).toHaveLength(0);
  });
});
