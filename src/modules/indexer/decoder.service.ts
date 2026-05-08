import { Injectable, Logger } from '@nestjs/common';
import { decodeTransactionEvents, type DecodedEvent as SdkDecodedEvent } from '@areal/sdk/events';
import {
  FUTARCHY_PROGRAM_ID,
  NATIVE_DEX_PROGRAM_ID,
  OWNERSHIP_TOKEN_PROGRAM_ID,
  RWT_ENGINE_PROGRAM_ID,
  YIELD_DISTRIBUTION_PROGRAM_ID,
} from '@areal/sdk/network';
import { PublicKey } from '@solana/web3.js';

/**
 * Thin DI facade over `@areal/sdk/events`.
 *
 * The actual event decoder (discriminator tables, borsh deserialisation,
 * CPI-aware invoke-stack walking) lives in the SDK so every Areal consumer
 * — bots, panel, backend, future Rust readers — speaks the same wire format
 * via the same code. This service exists only to:
 *
 *   1. give Nest a `@Injectable()` to wire into listeners / consumers /
 *      health probes (DI consistency — swapping the underlying lib means
 *      changing one file);
 *   2. expose the canonical list of registered program IDs in one place
 *      (used by `ChainListenerService` to subscribe, by `BackfillService`
 *      to seed the historical sweep, etc).
 *
 * Re-exports `DecodedEvent` from the SDK so downstream files (persister,
 * tests) keep importing the type from a single backend-local path.
 *
 * NOTE on `logIndex`:
 *   The SDK returns events in encounter order. The 0-based array index of
 *   each event matches the `(signature, log_index)` uniqueness contract on
 *   `areal.events`. Don't reuse Solana's transaction-wide log index — the
 *   chain doesn't number per-program-data lines, and using the array
 *   ordinal keeps the persister upsert key stable across reconcile / live.
 */
export type DecodedEvent = SdkDecodedEvent;

const REGISTERED_PROGRAM_IDS: readonly PublicKey[] = [
  NATIVE_DEX_PROGRAM_ID,
  OWNERSHIP_TOKEN_PROGRAM_ID,
  RWT_ENGINE_PROGRAM_ID,
  YIELD_DISTRIBUTION_PROGRAM_ID,
  FUTARCHY_PROGRAM_ID,
];

@Injectable()
export class DecoderService {
  private readonly logger = new Logger(DecoderService.name);

  constructor() {
    this.logger.log(
      `decoder facade ready — delegating to @areal/sdk/events for ${REGISTERED_PROGRAM_IDS.length} programs`,
    );
  }

  /** Returns the list of program IDs the indexer is configured for. */
  getRegisteredProgramIds(): readonly PublicKey[] {
    return REGISTERED_PROGRAM_IDS;
  }

  /**
   * Decode every Areal event emitted by `programId` in a transaction's logs.
   *
   * The returned `logIndex` is the 0-based ordinal of the event among the
   * filtered (programId-only) decoded events — combined with `signature`
   * it matches the unique key on `areal.events`.
   *
   * Lines that don't belong to `programId` (CPI'd from another program),
   * non-`Program data:` lines, and unknown discriminators are silently
   * skipped — the SDK's invoke-stack walker handles attribution correctly.
   */
  decodeLogs(
    programId: PublicKey,
    logs: readonly string[],
  ): Array<{ event: DecodedEvent; logIndex: number }> {
    const events = decodeTransactionEvents(logs, [programId]);
    return events.map((event, logIndex) => ({ event, logIndex }));
  }
}
