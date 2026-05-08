import { Connection, PublicKey } from '@solana/web3.js';
import type { Job } from 'bull';
import type { DataSource, EntityManager } from 'typeorm';
import { describe, expect, it, vi } from 'vitest';

import type { EventProjectionService } from '../projections/event-projection.service.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import type { DecoderService, DecodedEvent } from './decoder.service.js';
import type { IndexerJob } from './dto/event-job.dto.js';
import { IndexerConsumer } from './indexer.consumer.js';
import type { PersisterService } from './persister.service.js';

/**
 * Integration-flavoured tests for `IndexerConsumer` (R-12.3.1-4).
 *
 * The contract under test is the projector emit-on-rollback safety:
 *
 *   - Per the gateway/consumer split, emits are COLLECTED inside the
 *     wrapping `dataSource.transaction(...)` callback (the projector
 *     returns an `emit` payload which the consumer pushes into a local
 *     array), and FANNED OUT after the callback resolves. If the
 *     callback throws (projector / persister failure), the TX rolls back
 *     and the local array is discarded — no emit ever reaches
 *     `RealtimeService.emitTransactionIndexed`.
 *
 *   - That contract is structurally enforced (the array lives inside
 *     the for-loop body) but only indirectly tested via projector unit
 *     specs; this file exercises it end-to-end at the consumer level.
 *
 * Cadence note: the consumer creates one `dataSource.transaction(...)`
 * per decoded event and emits per emit-payload — i.e. an N-event
 * transaction yields N emits. Tests below match this structure.
 *
 * We mock all collaborators so the test runs without a real DB / Redis.
 */

const PROGRAM_ID_BASE58 = '4qhCgHSrkAtsETnxa5Cb5RDJ7QC5tCqJZyhyAuvxoNzG';
const SIGNATURE = '5XqXJ8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a8a';
const WALLET = 'DYw8jCTfwHNRJhhmFcbXvVDTqWMEVFBX6ZKUmG5CNSKK';

function makeDecodedEvent(name: string): DecodedEvent {
  // The decoder returns an SDK-shaped event; the consumer only forwards it
  // to the projector + persister, which we mock. Cast through `unknown` to
  // dodge SDK-internal field shape.
  return { name, payload: {} } as unknown as DecodedEvent;
}

interface ConsumerDeps {
  decoder: DecoderService;
  persister: PersisterService;
  projections: EventProjectionService;
  realtime: RealtimeService;
  dataSource: DataSource;
  conn: Connection;
}

function makeDeps(opts: {
  decodedEvents: DecodedEvent[];
  // For each event index, what should the projector return / throw.
  projectionBehaviour?: Array<
    | { kind: 'emit'; wallet: string }
    | { kind: 'noop' }
    | { kind: 'throw' }
  >;
}): ConsumerDeps {
  const decoder: DecoderService = {
    decodeLogs: vi.fn().mockReturnValue(
      opts.decodedEvents.map((event, idx) => ({ event, logIndex: idx })),
    ),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const persister: PersisterService = {
    persistInTx: vi.fn().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  // The projector dispatcher: returns an emit payload, returns null, or
  // throws — all gated by the per-event behaviour table.
  let projectionCallIdx = 0;
  const projectInTx = vi.fn(
    async (
      _em: EntityManager,
      _event: DecodedEvent,
      _meta: unknown,
    ): Promise<
      { wallet: string; kind: string; signature: string; blockTime: number } | null
    > => {
      const idx = projectionCallIdx;
      projectionCallIdx += 1;
      const behaviour = opts.projectionBehaviour?.[idx] ?? { kind: 'emit', wallet: WALLET };
      if (behaviour.kind === 'throw') {
        throw new Error('projector boom');
      }
      if (behaviour.kind === 'noop') return null;
      return {
        wallet: behaviour.wallet,
        kind: 'claim',
        signature: SIGNATURE,
        blockTime: 1_700_000_000,
      };
    },
  );

  const projections: EventProjectionService = {
    projectInTx,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const realtime: RealtimeService = {
    emitTransactionIndexed: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  // Mimic TypeORM's `dataSource.transaction(cb)`: invoke the callback with
  // a fake EntityManager, then resolve OR reject based on whether the
  // callback threw. This is the exact knob that lets us assert the
  // emit-on-rollback contract.
  const dataSource: DataSource = {
    transaction: vi.fn().mockImplementation(async (cb: (m: EntityManager) => Promise<void>) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fakeManager = {} as any;
      // Let the callback run; if it throws, the TX "rolls back" — the
      // outer await rejects and the consumer's emit-fan-out never runs.
      await cb(fakeManager);
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const conn: Connection = {
    getTransaction: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  return { decoder, persister, projections, realtime, dataSource, conn };
}

function makeConsumer(deps: ConsumerDeps): IndexerConsumer {
  return new IndexerConsumer(
    deps.decoder,
    deps.persister,
    deps.projections,
    deps.realtime,
    deps.dataSource,
    deps.conn,
  );
}

function makeLiveJob(logs: string[] = ['Program log: foo']): Job<
  Extract<IndexerJob, { kind: 'live' }>
> {
  return {
    data: {
      kind: 'live',
      programId: PROGRAM_ID_BASE58,
      signature: SIGNATURE,
      slot: 12345,
      blockTime: 1_700_000_000,
      logs,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe('IndexerConsumer', () => {
  describe('emit-on-rollback contract (R-12.3.1-4)', () => {
    it('happy path: 2 events both projected → 2 emits AFTER each commit', async () => {
      const deps = makeDeps({
        decodedEvents: [makeDecodedEvent('Claim'), makeDecodedEvent('Swap')],
        // Both succeed.
        projectionBehaviour: [
          { kind: 'emit', wallet: WALLET },
          { kind: 'emit', wallet: WALLET },
        ],
      });
      const consumer = makeConsumer(deps);

      await consumer.handleLive(makeLiveJob());

      // Both TXes ran.
      expect(deps.dataSource.transaction).toHaveBeenCalledTimes(2);
      // Both projector calls made.
      expect(deps.projections.projectInTx).toHaveBeenCalledTimes(2);
      // Both persister calls made.
      expect(deps.persister.persistInTx).toHaveBeenCalledTimes(2);
      // Per-event emit cadence — 2 events = 2 emits.
      expect(deps.realtime.emitTransactionIndexed).toHaveBeenCalledTimes(2);
      const calls = (
        deps.realtime.emitTransactionIndexed as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls;
      expect(calls[0]?.[0]).toMatchObject({ wallet: WALLET, signature: SIGNATURE });
    });

    it('rollback path: 2nd projector throws → TX rejects, NO emit (0 calls)', async () => {
      const deps = makeDeps({
        decodedEvents: [makeDecodedEvent('Claim'), makeDecodedEvent('Swap')],
        projectionBehaviour: [
          // First event projects fine ...
          { kind: 'emit', wallet: WALLET },
          // ... second event's projector throws inside the TX callback.
          { kind: 'throw' },
        ],
      });
      const consumer = makeConsumer(deps);

      // The consumer rethrows so Bull's retry policy can pick it up.
      await expect(consumer.handleLive(makeLiveJob())).rejects.toThrow('projector boom');

      // First event's TX ran AND its emit fired (the failure is in the
      // SECOND iteration of the for-loop). This is the consumer's actual
      // per-event cadence — verify it explicitly so a future refactor
      // doesn't silently change it.
      expect(
        (deps.realtime.emitTransactionIndexed as unknown as { mock: { calls: unknown[][] } })
          .mock.calls.length,
      ).toBe(1);

      // The 2nd persister was called (inside the rolled-back TX) ...
      expect(deps.persister.persistInTx).toHaveBeenCalledTimes(2);
      expect(deps.projections.projectInTx).toHaveBeenCalledTimes(2);
      // ... but the 2nd emit was NOT — that's the contract under test.
      // We want exactly 1 emit (from event #1 which committed cleanly),
      // never 2.
      expect(deps.realtime.emitTransactionIndexed).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'swap' }),
      );
    });

    it('rollback path: ALL events fail → 0 emits, even though projector returned partial payloads', async () => {
      const deps = makeDeps({
        decodedEvents: [makeDecodedEvent('Claim')],
        projectionBehaviour: [{ kind: 'throw' }],
      });
      const consumer = makeConsumer(deps);

      await expect(consumer.handleLive(makeLiveJob())).rejects.toThrow();
      // Hard guarantee: a projector failure NEVER leaks an emit.
      expect(deps.realtime.emitTransactionIndexed).not.toHaveBeenCalled();
    });

    it('persister failure inside TX also blocks the emit', async () => {
      const deps = makeDeps({
        decodedEvents: [makeDecodedEvent('Claim')],
      });
      // Override the persister to throw so we exercise the other failure
      // branch — the contract must hold whether the throw originates in
      // the persister or the projector.
      (deps.persister.persistInTx as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('persister boom'),
      );
      const consumer = makeConsumer(deps);

      await expect(consumer.handleLive(makeLiveJob())).rejects.toThrow('persister boom');
      expect(deps.realtime.emitTransactionIndexed).not.toHaveBeenCalled();
    });

    it('decoder yields 0 events → consumer is a clean no-op (0 TXes, 0 emits)', async () => {
      const deps = makeDeps({ decodedEvents: [] });
      const consumer = makeConsumer(deps);

      await consumer.handleLive(makeLiveJob());

      expect(deps.dataSource.transaction).not.toHaveBeenCalled();
      expect(deps.persister.persistInTx).not.toHaveBeenCalled();
      expect(deps.projections.projectInTx).not.toHaveBeenCalled();
      expect(deps.realtime.emitTransactionIndexed).not.toHaveBeenCalled();
    });
  });
});
