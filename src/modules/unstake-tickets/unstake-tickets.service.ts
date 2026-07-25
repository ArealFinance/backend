import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, PublicKey, type GetProgramAccountsFilter } from '@solana/web3.js';

import { SOLANA_CONNECTION } from '../../common/solana/connection.module.js';
import type { SolanaCluster } from '../../config/configuration.js';
import type { UnstakeTicketDto, UnstakeTicketsResponseDto } from './dto/unstake-tickets.dto.js';

/** The audited staking deployment this public endpoint is intentionally pinned to. */
export const MAINNET_STAKING_PROGRAM_ID = new PublicKey(
  '9tEKvDwkqkveBvmQfEzgPKWSNCDTGSSqYz4ZE6pP5DGY',
);

const UNSTAKE_TICKET_SIZE = 65;
const OWNER_OFFSET = 8;
const AMOUNT_RWT_OFFSET = 40;
const UNLOCK_TS_OFFSET = 48;
const NONCE_OFFSET = 56;
const BUMP_OFFSET = 64;
const UNSTAKE_TICKET_DISCRIMINATOR = Buffer.from([
  0x83, 0x54, 0xd1, 0x26, 0x91, 0x9d, 0xb5, 0x7f,
]);
const UNSTAKE_SEED = Buffer.from('unstake');

/**
 * Scans the fixed mainnet staking program for the caller's UnstakeTicket
 * accounts. All query controls are constants: callers can supply only owner.
 */
@Injectable()
export class UnstakeTicketsService {
  private readonly logger = new Logger(UnstakeTicketsService.name);
  /**
   * Coalesces only concurrent requests for the same canonical wallet. Entries
   * are removed as soon as their RPC request settles, so this is not a response
   * cache and cannot make a just-claimed ticket appear stale.
   */
  private readonly inFlightByWallet = new Map<string, Promise<UnstakeTicketsResponseDto>>();

  constructor(
    @Inject(SOLANA_CONNECTION) private readonly connection: Connection,
    private readonly config: ConfigService,
  ) {}

  listForWallet(wallet: string): Promise<UnstakeTicketsResponseDto> {
    const owner = new PublicKey(wallet);
    const canonicalWallet = owner.toBase58();
    const inFlight = this.inFlightByWallet.get(canonicalWallet);
    if (inFlight) return inFlight;

    const request = this.listForOwner(owner).finally(() => {
      // Do not erase a newer request if a future implementation ever replaces
      // the map entry before this one settles.
      if (this.inFlightByWallet.get(canonicalWallet) === request) {
        this.inFlightByWallet.delete(canonicalWallet);
      }
    });
    this.inFlightByWallet.set(canonicalWallet, request);
    return request;
  }

  private async listForOwner(owner: PublicKey): Promise<UnstakeTicketsResponseDto> {
    // This account layout and program pin are mainnet-specific. Never send a
    // costly scan to a devnet/localnet endpoint where the same address could
    // mean a different deployment.
    if (this.config.get<SolanaCluster>('solana.cluster') !== 'mainnet') {
      throw new ServiceUnavailableException('mainnet unstake-ticket service unavailable');
    }

    const filters: GetProgramAccountsFilter[] = [
      { dataSize: UNSTAKE_TICKET_SIZE },
      { memcmp: { offset: OWNER_OFFSET, bytes: owner.toBase58() } },
    ];

    let accounts: Awaited<ReturnType<Connection['getProgramAccounts']>>;
    try {
      accounts = await this.connection.getProgramAccounts(MAINNET_STAKING_PROGRAM_ID, {
        commitment: 'confirmed',
        filters,
      });
    } catch {
      // Upstream errors can contain an RPC URL or provider-specific details.
      // Keep both logs and the HTTP response free of those values.
      this.logger.warn('mainnet unstake-ticket RPC request failed');
      throw new ServiceUnavailableException('Solana RPC temporarily unavailable');
    }

    const tickets: UnstakeTicketDto[] = [];
    for (const { pubkey, account } of accounts) {
      const ticket = decodeTicket(pubkey, account.owner, account.data, owner);
      if (ticket) tickets.push(ticket);
    }
    tickets.sort((a, b) => {
      const unlockOrder =
        BigInt(a.unlockTsSec) < BigInt(b.unlockTsSec)
          ? -1
          : BigInt(a.unlockTsSec) > BigInt(b.unlockTsSec)
            ? 1
            : 0;
      if (unlockOrder !== 0) return unlockOrder;
      return a.ticket < b.ticket ? -1 : a.ticket > b.ticket ? 1 : 0;
    });

    return { tickets };
  }
}

function decodeTicket(
  pubkey: PublicKey,
  accountOwner: PublicKey,
  data: Buffer,
  owner: PublicKey,
): UnstakeTicketDto | null {
  // The RPC filter requests exactly 65 bytes. Keep this guard anyway: malformed
  // provider data must not turn an otherwise safe read endpoint into a 500.
  if (data.length !== UNSTAKE_TICKET_SIZE) return null;
  if (!accountOwner.equals(MAINNET_STAKING_PROGRAM_ID)) return null;
  if (!data.subarray(0, 8).equals(UNSTAKE_TICKET_DISCRIMINATOR)) return null;
  if (!data.subarray(OWNER_OFFSET, AMOUNT_RWT_OFFSET).equals(owner.toBuffer())) return null;

  const nonce = data.readBigUInt64LE(NONCE_OFFSET);
  const nonceLe = Buffer.alloc(8);
  nonceLe.writeBigUInt64LE(nonce);
  const [expectedPda, bump] = PublicKey.findProgramAddressSync(
    [UNSTAKE_SEED, owner.toBuffer(), nonceLe],
    MAINNET_STAKING_PROGRAM_ID,
  );
  if (!pubkey.equals(expectedPda) || data[BUMP_OFFSET] !== bump) return null;

  const unlockTsSeconds = data.readBigInt64LE(UNLOCK_TS_OFFSET);

  return {
    ticket: pubkey.toBase58(),
    amountRwtBaseUnits: data.readBigUInt64LE(AMOUNT_RWT_OFFSET).toString(),
    unlockTsSec: unlockTsSeconds.toString(),
    nonce: nonce.toString(),
  };
}
