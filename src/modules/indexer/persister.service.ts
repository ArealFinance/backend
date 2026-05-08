import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { Event } from '../../entities/event.entity.js';
import type { DecodedEvent } from './decoder.service.js';

/**
 * Idempotent persister for raw chain events.
 *
 * The unique constraint `(signature, program_id, log_index)` is the de-dupe
 * key, so we UPSERT and do nothing on conflict. We include `program_id` in
 * the key because multi-program transactions (CPI from one Areal program
 * into another) emit independent per-program log streams — each with its
 * own 0-indexed `log_index`. A 2-tuple key would silently drop the second
 * program's events on conflict.
 *
 * This is the single point where chain data lands in our DB; downstream
 * projections read FROM `events`.
 *
 * Field-extraction notes:
 *   The IDL field names are snake_case (Anchor convention) but the SDK
 *   decoder (`@areal/sdk/events`) remaps them to camelCase before we see
 *   them — see `sdk/src/events/registry.ts::remapPayload`. To keep the
 *   denormalised lookup columns (`primary_actor`, `pool`, `ot_mint`)
 *   correct across all 60 event types, we look for a small canonical set
 *   of likely camelCase keys per concept and pick the first one present.
 *   Adding new events doesn't require touching this file unless they
 *   introduce a brand new actor concept.
 */
export interface PersistMeta {
  signature: string;
  logIndex: number;
  slot: number;
  blockTime: Date;
}

@Injectable()
export class PersisterService {
  private readonly logger = new Logger(PersisterService.name);

  constructor(@InjectRepository(Event) private readonly events: Repository<Event>) {}

  /**
   * Public single-event persist (no TX wrapper).
   *
   * Kept as the original entry-point for code paths that don't need to
   * project (reconcile sweep, future direct-ingest tooling). When a caller
   * needs the persist + projection bundled into one Postgres transaction
   * (the indexer consumer does), use `persistInTx()` against the manager
   * supplied by `dataSource.transaction()`.
   */
  async persist(decoded: DecodedEvent, meta: PersistMeta): Promise<void> {
    try {
      await this.persistInTx(this.events.manager, decoded, meta);
    } catch (err) {
      this.logger.error(
        `persist failed for ${decoded.eventName} ${meta.signature}#${meta.logIndex}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }
  }

  /**
   * Persist within an external EntityManager — used by the indexer consumer
   * to bundle persist + projection into one TX so neither lands without the
   * other (no half-projected events).
   *
   * Errors propagate to the caller; the wrapping `dataSource.transaction()`
   * rolls back on throw.
   */
  async persistInTx(
    manager: EntityManager,
    decoded: DecodedEvent,
    meta: PersistMeta,
  ): Promise<void> {
    // Build the entity literal then cast to Partial<Event> — TypeORM's
    // generated `_QueryDeepPartialEntity` treats `jsonb` columns as a deep
    // partial (recursing into `Record<string, unknown>`), which doesn't
    // round-trip through TS inference. The runtime contract is identical.
    const row: Partial<Event> = {
      programId: decoded.programId.toBase58(),
      eventName: decoded.eventName,
      signature: meta.signature,
      logIndex: meta.logIndex,
      slot: String(meta.slot),
      blockTime: meta.blockTime,
      body: this.normaliseForJson(decoded.data),
      primaryActor: extractPrimaryActor(decoded.data),
      pool: extractPool(decoded.data),
      otMint: extractOtMint(decoded.data),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await manager.getRepository(Event).upsert(row as any, {
      conflictPaths: ['signature', 'programId', 'logIndex'],
      skipUpdateIfNoValuesChanged: true,
    });
  }

  /**
   * Recursively coerce decoded values to JSON-safe shapes:
   *   - `bigint` → string (Postgres jsonb can't store native bigint).
   *   - Buffer / Uint8Array → base58 string IF length 32 (PublicKey-shaped),
   *     else hex string.
   *   - PublicKey-like objects (anything with `.toBase58()`) → base58 string.
   * Other primitives pass through. Field names are camelCase as supplied by
   * the SDK decoder (`@areal/sdk/events`) — projection / extract helpers and
   * downstream readers all key on camelCase.
   */
  private normaliseForJson(input: unknown): Record<string, unknown> {
    return this.normaliseValue(input) as Record<string, unknown>;
  }

  private normaliseValue(v: unknown): unknown {
    if (v === null || v === undefined) return v;
    if (typeof v === 'bigint') return v.toString();
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
    if (Buffer.isBuffer(v) || v instanceof Uint8Array) {
      // Heuristic: 32-byte buffer almost always = PublicKey or hash.
      // We export as hex (lossless, easy to re-parse). Callers that need
      // base58 can convert in projection logic.
      return Buffer.from(v).toString('hex');
    }
    if (Array.isArray(v)) return v.map((x) => this.normaliseValue(x));
    if (typeof v === 'object') {
      const obj = v as { toBase58?: () => string };
      if (typeof obj.toBase58 === 'function') return obj.toBase58();
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = this.normaliseValue(val);
      }
      return out;
    }
    return v;
  }
}

/**
 * Try a series of plausible field names for the "primary actor" — the user
 * pubkey responsible for the event (depositor, swapper, claimant, etc).
 * Keys are camelCase to match the SDK decoder output. Returns null if no
 * match — events like `DexInitialized` have no actor.
 */
export function extractPrimaryActor(data: Record<string, unknown>): string | null {
  const keys = ['user', 'depositor', 'swapper', 'claimant', 'recipient', 'authority', 'funder'];
  return pickFirstString(data, keys);
}

export function extractPool(data: Record<string, unknown>): string | null {
  // Pool concept across native-dex (`pool`), nexus (`nexusPool`,
  // `lpPosition`), futarchy (`market`), distributors (`distributor`).
  // Keys are camelCase to match the SDK decoder output.
  const keys = ['pool', 'nexusPool', 'lpPosition', 'distributor', 'market'];
  return pickFirstString(data, keys);
}

export function extractOtMint(data: Record<string, unknown>): string | null {
  // camelCase to match the SDK decoder output.
  const keys = ['otMint', 'mint', 'rwtMint'];
  return pickFirstString(data, keys);
}

function pickFirstString(data: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = data[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}
