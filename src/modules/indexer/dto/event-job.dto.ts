/**
 * Bull job payload for the indexer queue.
 *
 * Two job kinds:
 *   - `live`: dispatched from the websocket `onLogs` callback. We have the
 *     full log array in hand, so we ship it inline to avoid a redundant
 *     `getTransaction` round-trip.
 *   - `historical`: dispatched from `BackfillService` and `ReconcileService`.
 *     Only the signature is known; the consumer fetches the full transaction
 *     via `getTransaction` before decoding.
 *
 * Idempotency lives downstream in `PersisterService.persist()` (UPSERT on
 * `(signature, log_index)`), so a job replayed by Bull's at-least-once
 * delivery semantics is safe.
 */
export type IndexerJob = LiveEventJob | HistoricalEventJob;

export interface LiveEventJob {
  kind: 'live';
  programId: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  logs: string[];
}

export interface HistoricalEventJob {
  kind: 'historical';
  programId: string;
  signature: string;
  slot: number;
  blockTime: number | null;
}

export const INDEXER_QUEUE_NAME = 'indexer:events';
