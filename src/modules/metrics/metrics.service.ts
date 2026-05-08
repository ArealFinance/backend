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

  onModuleInit(): void {
    collectDefaultMetrics({ register: this.registry });
    this.registry.registerMetric(this.eventsPersisted);
    this.registry.registerMetric(this.queueDepth);
    this.registry.registerMetric(this.persistLatency);
    this.registry.registerMetric(this.authFailures);
  }
}
