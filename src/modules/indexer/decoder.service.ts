import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decodeTransactionEvents, type DecodedEvent as SdkDecodedEvent } from '@areal/sdk/events';
import { getProgramIds, type ClusterName } from '@areal/sdk/network';
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
 *      to seed the historical sweep, etc) — RESOLVED PER-CLUSTER from
 *      `solana.cluster` config so the devnet indexer subscribes to devnet
 *      pubkeys, not mainnet ones.
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

@Injectable()
export class DecoderService {
  private readonly logger = new Logger(DecoderService.name);
  private readonly registeredProgramIds: readonly PublicKey[];

  constructor(private readonly configService: ConfigService) {
    // Resolve the cluster from config (set by SOLANA_CLUSTER env). Fall back
    // to devnet to match the rest of the backend's default — never to
    // mainnet, which would silently subscribe to the wrong .so addresses
    // and yield a blind indexer.
    const cluster = (this.configService.get<string>('solana.cluster') ??
      'devnet') as ClusterName;
    const ids = getProgramIds(cluster);
    this.registeredProgramIds = [
      ids.nativeDex,
      ids.ownershipToken,
      ids.rwtEngine,
      ids.yieldDistribution,
      ids.futarchy,
    ];
    this.logger.log(
      `decoder facade ready — cluster=${cluster}, ${this.registeredProgramIds.length} programs: ${this.registeredProgramIds
        .map((p) => p.toBase58())
        .join(', ')}`,
    );
  }

  /** Returns the list of program IDs the indexer is configured for. */
  getRegisteredProgramIds(): readonly PublicKey[] {
    return this.registeredProgramIds;
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
