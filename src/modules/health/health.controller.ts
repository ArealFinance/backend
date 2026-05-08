import { Controller, Get, Inject, Logger } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Connection } from '@solana/web3.js';
import { DataSource } from 'typeorm';

import { SOLANA_CONNECTION } from '../indexer/connection.provider.js';

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
      return {
        status: 'down',
        detail: err instanceof Error ? err.message : String(err),
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
      return {
        status: 'down',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
