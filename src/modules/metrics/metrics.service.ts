import { Injectable, type OnModuleInit } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/**
 * Centralised Prometheus registry + the metric vectors used across the app.
 *
 * Default node-process metrics (cpu, heap, gc, etc) are auto-registered by
 * `collectDefaultMetrics`. Custom application metrics are declared once here
 * so labels stay consistent across modules. Add a new metric: declare it as
 * a public field, register it in the constructor, and inject this service
 * wherever the increment lives.
 */
@Injectable()
export class MetricsService implements OnModuleInit {
  readonly registry = new Registry();

  /** Total Areal events persisted, labelled by program + event name. */
  readonly eventsPersisted = new Counter({
    name: 'areal_events_persisted_total',
    help: 'Total Areal events persisted to the events table',
    labelNames: ['program', 'event'] as const,
  });

  /** Indexer queue depth, sampled per scrape. */
  readonly queueDepth = new Gauge({
    name: 'areal_indexer_queue_depth',
    help: 'Pending jobs in the indexer queue',
    labelNames: ['state'] as const,
  });

  /** Histogram of persister write latency. */
  readonly persistLatency = new Histogram({
    name: 'areal_persist_latency_seconds',
    help: 'Persister write latency (seconds)',
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  });

  /** Counter of auth failures by reason, used for rate-limiting decisions. */
  readonly authFailures = new Counter({
    name: 'areal_auth_failures_total',
    help: 'Failed login attempts',
    labelNames: ['reason'] as const,
  });

  /**
   * Histogram of per-event projection latency (Phase 12.2.1).
   * Buckets target sub-millisecond → 1s; alert on p95 > 50ms because the
   * persister TX wraps every projection inline.
   */
  readonly projectionLatency = new Histogram({
    name: 'areal_projection_latency_seconds',
    help: 'Projection write latency (seconds) per event',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  });

  /**
   * Counter of projector failures by event name. Surfaces silent regressions
   * in IDL drift (a renamed field would throw `requireString` and increment
   * this counter without changing the persisted-events count).
   */
  readonly projectionErrors = new Counter({
    name: 'areal_projection_errors_total',
    help: 'Projector failures by event name',
    labelNames: ['event_name'] as const,
  });

  // ── Phase 12.3.1: markets aggregator + realtime ──────────────────────────

  /**
   * Aggregator job duration. One label per cron job (`snapshot60s`,
   * `rollup5m`, `summary30s`). Alert on p95 > 30s for `snapshot60s` —
   * a slow snapshot starves the next tick and the realtime emit cadence
   * drifts.
   */
  readonly aggregatorLatency = new Histogram({
    name: 'aggregator_latency_seconds',
    help: 'Markets aggregator job latency (seconds) by job',
    labelNames: ['job'] as const,
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
  });

  /**
   * Aggregator skip counter — incremented when the advisory lock is held
   * by another worker and we silently no-op. A persistent non-zero rate
   * usually signals a wedged job (lock acquired and never released).
   */
  readonly aggregatorSkipTotal = new Counter({
    name: 'aggregator_skip_total',
    help: 'Aggregator job skips (advisory lock contention)',
    labelNames: ['job'] as const,
  });

  /**
   * RPC failure counter for the markets reader. Distinct from
   * `projection_errors` because aggregator failures don't roll back
   * a chain-event TX — they only delay the next snapshot.
   */
  readonly aggregatorRpcFailures = new Counter({
    name: 'aggregator_rpc_failures_total',
    help: 'Aggregator RPC failures (markets reader / chain reads)',
    labelNames: ['job'] as const,
  });

  /**
   * Total Socket.IO connections accepted. Includes both authenticated
   * (with JWT) and anonymous connections — anonymity is allowed for
   * public rooms (`protocol`, `pool:*`).
   */
  readonly realtimeConnections = new Counter({
    name: 'realtime_connections_total',
    help: 'Socket.IO connections accepted',
  });

  /**
   * Server-emitted realtime messages, labelled by channel. Useful for
   * detecting silent emit-loop regressions (e.g. a new event that fires
   * 10x more often than expected).
   */
  readonly realtimeEmits = new Counter({
    name: 'realtime_emits_total',
    help: 'Server-side realtime emits by channel',
    labelNames: ['channel'] as const,
  });

  /**
   * Subscription requests by room type (`protocol`, `pool`, `wallet`).
   * Failed subscriptions (auth rejection, malformed room) increment the
   * `rejected` label so ops can spot client bugs.
   */
  readonly realtimeSubscriptions = new Counter({
    name: 'realtime_subscriptions_total',
    help: 'Realtime subscribe attempts by room type',
    labelNames: ['room_type', 'outcome'] as const,
  });

  /**
   * Guards against double-init when the same instance is wired into both the
   * main Nest app and the secondary MetricsAppModule (Phase 12.1 split-listener
   * pattern). Both DI contexts call `onModuleInit` on the shared instance;
   * `collectDefaultMetrics` and `registerMetric` would otherwise throw on the
   * second call ("metric already registered").
   */
  private initialised = false;

  onModuleInit(): void {
    if (this.initialised) return;
    this.initialised = true;
    collectDefaultMetrics({ register: this.registry });
    this.registry.registerMetric(this.eventsPersisted);
    this.registry.registerMetric(this.queueDepth);
    this.registry.registerMetric(this.persistLatency);
    this.registry.registerMetric(this.authFailures);
    this.registry.registerMetric(this.projectionLatency);
    this.registry.registerMetric(this.projectionErrors);
    this.registry.registerMetric(this.aggregatorLatency);
    this.registry.registerMetric(this.aggregatorSkipTotal);
    this.registry.registerMetric(this.aggregatorRpcFailures);
    this.registry.registerMetric(this.realtimeConnections);
    this.registry.registerMetric(this.realtimeEmits);
    this.registry.registerMetric(this.realtimeSubscriptions);
  }
}
