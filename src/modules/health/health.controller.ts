import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Connection } from '@solana/web3.js';
import { DataSource } from 'typeorm';

import { SOLANA_CONNECTION } from '../../common/solana/connection.module.js';

interface DependencyHealth {
  status: 'ok' | 'down';
  detail?: string;
  latencyMs?: number;
}

interface HealthResponse {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptimeSecs: number;
  dependencies: {
    database: DependencyHealth;
    rpc: DependencyHealth;
  };
}

/**
 * `/health` is the canonical liveness/readiness endpoint.
 *
 * Returns `200 ok` when DB + RPC respond, `200 degraded` if any dependency
 * is unreachable. We deliberately stay on 200 either way so a flapping RPC
 * does NOT take the API offline at the load balancer — operators should
 * prefer `/metrics` for SLO-grade signals.
 *
 * Redis is intentionally NOT probed here — the BullModule already crashes
 * the process on hard Redis loss, so by the time `/health` answers, Redis
 * is reachable. Adding a Redis probe just adds a useless extra round-trip.
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly dataSource: DataSource,
    @Inject(SOLANA_CONNECTION) private readonly conn: Connection,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Liveness/readiness probe' })
  @ApiResponse({ status: 200, description: 'Health snapshot (status may be degraded)' })
  async check(): Promise<HealthResponse> {
    const [database, rpc] = await Promise.all([this.checkDatabase(), this.checkRpc()]);
    const allOk = database.status === 'ok' && rpc.status === 'ok';
    return {
      status: allOk ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      uptimeSecs: Math.round(process.uptime()),
      dependencies: { database, rpc },
    };
  }

  private async checkDatabase(): Promise<DependencyHealth> {
    const start = Date.now();
    try {
      await this.dataSource.query('SELECT 1');
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
      // Internal driver / network details are interesting to operators, not
      // to anyone hitting /health unauthenticated. Log the raw error and
      // return a categorised string in production.
      const raw = err instanceof Error ? err.message : String(err);
      this.logger.warn(`/health DB probe failed: ${raw}`);
      return {
        status: 'down',
        detail: scrubProbeError(raw),
      };
    }
  }

  private async checkRpc(): Promise<DependencyHealth> {
    const start = Date.now();
    try {
      // `getSlot` is the cheapest endpoint that proves the RPC is reachable,
      // authenticated, and serving recent state.
      await this.conn.getSlot('confirmed');
      return { status: 'ok', latencyMs: Date.now() - start };
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      this.logger.warn(`/health RPC probe failed: ${raw}`);
      return {
        status: 'down',
        detail: scrubProbeError(raw),
      };
    }
  }
}

/**
 * Map raw probe errors to a tiny set of categorical strings in production.
 * Outside production we keep the raw message so dev can debug; in production
 * we never ship driver internals (RPC URLs, connection strings, stack
 * fragments) to an unauthenticated probe endpoint.
 *
 * Categories chosen to be useful for an alerting dashboard while leaking no
 * implementation detail:
 *   - 'timeout'      → request didn't complete in time
 *   - 'auth_failed'  → 401/403 from the upstream
 *   - 'unreachable'  → everything else (DNS, refused, TLS, 5xx, …)
 */
export function scrubProbeError(raw: string): string {
  if (process.env.NODE_ENV !== 'production') return raw;
  const lower = raw.toLowerCase();
  if (lower.includes('timeout') || lower.includes('etimedout')) return 'timeout';
  if (lower.includes('401') || lower.includes('403') || lower.includes('unauthorized')) {
    return 'auth_failed';
  }
  return 'unreachable';
}
