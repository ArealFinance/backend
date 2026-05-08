import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

import { Injectable, Logger } from '@nestjs/common';
import {
  buildTypeRegistry,
  deserializeAccount,
  eventDiscriminator,
  type Idl,
  type IdlEvent,
  type TypeRegistry,
} from '@arlex/client';
import { PublicKey } from '@solana/web3.js';

import {
  FUTARCHY_PROGRAM_ID,
  NATIVE_DEX_PROGRAM_ID,
  OWNERSHIP_TOKEN_PROGRAM_ID,
  RWT_ENGINE_PROGRAM_ID,
  YIELD_DISTRIBUTION_PROGRAM_ID,
} from '@areal/sdk/network';

/**
 * Resolve the directory of `@areal/sdk/idl/*.json` once at module init.
 *
 * The package exports `./idl/*.json` directly, so we use `createRequire` to
 * `require.resolve` the SDK package.json (works under ESM) and walk to the
 * `idl/` dir from there.
 *
 * Loading via `readFileSync` rather than `import x from '...json'` keeps the
 * decoder agnostic to whether the host runtime accepts JSON import-attribute
 * syntax — and avoids putting all 5 IDLs in the bundled output.
 */
const requireFromHere = createRequire(import.meta.url);
function loadIdl(name: string): Idl {
  // The SDK exports `./idl/*.json` directly via its `exports` map. We resolve
  // a known IDL (native-dex) to locate the install root, then load the
  // requested IDL by name from the same `idl/` directory. This avoids relying
  // on `./package.json` being exported (it isn't).
  const anchorIdl = requireFromHere.resolve('@areal/sdk/idl/native-dex.json');
  const idlDir = dirname(anchorIdl);
  const path = resolve(idlDir, `${name}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Idl;
}

/**
 * Decodes Anchor-compatible `#[event]` payloads from Solana program log lines.
 *
 * Algorithm:
 *   1. Filter for `Program data: <base64>` lines (Anchor's convention).
 *   2. Read the 8-byte event discriminator (sha256("event:<Name>")[..8]).
 *   3. Look up the matching event definition in the program's IDL.
 *   4. Deserialize the body via `deserializeAccount` (skipping its own
 *      discriminator-skip; we already pass body-only bytes).
 *
 * SDK 0.8.0 will likely ship a more ergonomic `decodeEvent(programId, log)`
 * helper — when it lands, we can swap this implementation for the SDK call
 * without touching the persister.
 */
export interface DecodedEvent {
  programId: PublicKey;
  eventName: string;
  /** Byte-for-byte raw payload bytes (post-discriminator). Useful for tests. */
  rawBody: Buffer;
  /** Decoded fields. Field names are snake_case as in the IDL. */
  data: Record<string, unknown>;
}

/** Per-program decoding context built once at module init. */
interface ProgramDecodingTable {
  programId: PublicKey;
  programIdString: string;
  /** discriminator(8 bytes hex) → event definition. */
  eventByDisc: Map<string, IdlEvent>;
  registry: TypeRegistry;
}

@Injectable()
export class DecoderService {
  private readonly logger = new Logger(DecoderService.name);

  /** Lookup keyed by programId base58. Populated in the constructor. */
  private readonly tables = new Map<string, ProgramDecodingTable>();

  constructor() {
    this.registerProgram(NATIVE_DEX_PROGRAM_ID, loadIdl('native-dex'));
    this.registerProgram(OWNERSHIP_TOKEN_PROGRAM_ID, loadIdl('ownership-token'));
    this.registerProgram(RWT_ENGINE_PROGRAM_ID, loadIdl('rwt-engine'));
    this.registerProgram(YIELD_DISTRIBUTION_PROGRAM_ID, loadIdl('yield-distribution'));
    this.registerProgram(FUTARCHY_PROGRAM_ID, loadIdl('futarchy'));
  }

  /** Returns the list of program IDs the decoder is configured for. */
  getRegisteredProgramIds(): PublicKey[] {
    return Array.from(this.tables.values()).map((t) => t.programId);
  }

  /**
   * Iterate over a transaction's log lines and yield every Areal event we can
   * decode. The `logIndex` returned is the 0-based ordinal of the event among
   * decoded events for the given program — combined with `signature` it
   * matches the `(signature, log_index)` unique key on `events`.
   *
   * Lines that aren't `Program data:` payloads, or that match an unknown
   * discriminator, are silently skipped (other programs' events, system
   * messages, etc).
   */
  decodeLogs(
    programId: PublicKey,
    logs: string[],
  ): Array<{ event: DecodedEvent; logIndex: number }> {
    const table = this.tables.get(programId.toBase58());
    if (!table) return [];

    const out: Array<{ event: DecodedEvent; logIndex: number }> = [];
    let logIndex = 0;
    for (const line of logs) {
      const decoded = this.decodeLine(table, line);
      if (!decoded) continue;
      out.push({ event: decoded, logIndex });
      logIndex += 1;
    }
    return out;
  }

  /**
   * Decode a single `Program data: <b64>` line. Public for unit tests.
   * Returns `null` for any line that isn't a valid Areal event payload.
   */
  decodeLine(programId: PublicKey, line: string): DecodedEvent | null;
  decodeLine(table: ProgramDecodingTable, line: string): DecodedEvent | null;
  decodeLine(
    programIdOrTable: PublicKey | ProgramDecodingTable,
    line: string,
  ): DecodedEvent | null {
    // Branch on a structural property rather than `instanceof PublicKey` — in
    // a test runner the PublicKey class can be loaded from multiple realms
    // (vitest worker vs main thread), making `instanceof` brittle.
    const isTable = (v: unknown): v is ProgramDecodingTable =>
      typeof v === 'object' && v !== null && 'eventByDisc' in v;
    const table = isTable(programIdOrTable)
      ? programIdOrTable
      : this.tables.get((programIdOrTable as PublicKey).toBase58());
    if (!table) return null;

    if (!line.startsWith('Program data: ')) return null;
    const b64 = line.slice('Program data: '.length).trim();
    let bytes: Buffer;
    try {
      bytes = Buffer.from(b64, 'base64');
    } catch {
      return null;
    }
    if (bytes.length < 8) return null;

    const discHex = bytes.subarray(0, 8).toString('hex');
    const evDef = table.eventByDisc.get(discHex);
    if (!evDef) return null;

    const body = bytes.subarray(8);
    let decodedFields: Record<string, unknown>;
    try {
      // `deserializeAccount` in @arlex/client skips its own 8-byte
      // discriminator. We already removed the discriminator above, so we
      // must re-prepend a dummy 8-byte prefix — or use the underlying
      // primitives. Simpler: re-prepend a zero-byte placeholder.
      const padded = Buffer.concat([Buffer.alloc(8), body]);
      decodedFields = deserializeAccount(evDef.fields, padded, table.registry);
    } catch (err) {
      this.logger.warn(
        `decode failed for ${evDef.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    return {
      programId: table.programId,
      eventName: evDef.name,
      rawBody: body,
      data: decodedFields,
    };
  }

  // -- internals -----------------------------------------------------------

  private registerProgram(programId: PublicKey, idl: Idl): void {
    if (!idl.events || idl.events.length === 0) {
      this.logger.warn(
        `IDL ${idl.name ?? programId.toBase58()} has no events — decoder will silently drop logs`,
      );
    }
    const eventByDisc = new Map<string, IdlEvent>();
    for (const ev of idl.events ?? []) {
      const disc = eventDiscriminator(ev.name).toString('hex');
      eventByDisc.set(disc, ev);
    }
    const registry = buildTypeRegistry(idl.types ?? [], idl.accounts ?? []);
    this.tables.set(programId.toBase58(), {
      programId,
      programIdString: programId.toBase58(),
      eventByDisc,
      registry,
    });
    this.logger.log(
      `registered ${eventByDisc.size} event types for program ${programId.toBase58()}`,
    );
  }
}
