import {
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import type { Redis } from 'ioredis';

import { SOLANA_CONNECTION } from '../../common/solana/connection.module.js';
import { FaucetClaimResponseDto } from './dto/faucet-claim-response.dto.js';
import {
  DEFAULT_AMOUNT,
  LOCK_TTL_SEC,
  MIN_FUNDING_LAMPORTS,
  RATE_LIMIT_TTL_SEC,
  USDC_DECIMALS,
  USDC_MINT_PUBKEY,
} from './faucet.constants.js';
import { FAUCET_REDIS } from './redis.provider.js';
import { FAUCET_AUTHORITY_KEYPAIR, FAUCET_FUNDER_KEYPAIR } from './keypair.tokens.js';
import { buildCreateAtaIx, buildMintToIx, findAta } from './spl/spl-ix.js';

/**
 * Localnet test-USDC faucet.
 *
 * Lifecycle of a single claim (`POST /faucet/usdc`):
 *   1. Pre-check: if the wallet has a live `claimed:<wallet>` key, 429.
 *   2. Acquire `lock:<wallet>` (SET NX EX, 30s). If already held, 429.
 *   3. Re-check claim mark inside the lock — guards against the
 *      classic check-then-act race where two requests pass step 1 in
 *      parallel.
 *   4. Build & submit the transaction:
 *        - Optional: create ATA if the recipient doesn't have one.
 *        - Optional: airdrop ~0.05 SOL if the recipient has zero balance,
 *          so they can pay rent for follow-up txs without rebooting.
 *        - Always: MintTo (authority signs).
 *   5. On confirmed signature, set `claimed:<wallet> = signature` with
 *      a 24h TTL.
 *   6. Always release the lock.
 *
 * Error policy:
 *   - User-visible errors that ARE meaningful (rate limits) are
 *     surfaced as `HttpException` with a `retryAfterSec` body.
 *   - Everything else (RPC failure, mint failure, unexpected exception)
 *     is collapsed to a generic `InternalServerErrorException` —
 *     internals are logged here, never echoed to the client.
 *
 * Logger discipline: never log the keypair objects, secret bytes, or
 * the full `error` value. Only the message + stack.
 */
@Injectable()
export class FaucetService {
  private readonly logger = new Logger(FaucetService.name);
  private readonly mintPk = new PublicKey(USDC_MINT_PUBKEY);

  constructor(
    @Inject(SOLANA_CONNECTION) private readonly connection: Connection,
    @Inject(FAUCET_REDIS) private readonly redis: Redis,
    @Inject(FAUCET_AUTHORITY_KEYPAIR) private readonly authority: Keypair | null,
    @Inject(FAUCET_FUNDER_KEYPAIR) private readonly funder: Keypair | null,
  ) {}

  private claimedKey(wallet: string): string {
    return `faucet:usdc:claimed:${wallet}`;
  }

  private lockKey(wallet: string): string {
    return `faucet:usdc:lock:${wallet}`;
  }

  async claim(wallet: string, amount?: number): Promise<FaucetClaimResponseDto> {
    // The localnet-only guard 404s before this method is reached on any
    // non-localnet cluster, so reaching this branch with a null
    // keypair indicates a misconfigured deployment — fail closed.
    if (!this.authority || !this.funder) {
      throw new NotFoundException();
    }

    const dripAmount = amount ?? DEFAULT_AMOUNT;

    // 1. Pre-check claim mark.
    const pttl1 = await this.redis.pttl(this.claimedKey(wallet));
    if (pttl1 > 0) {
      throw new HttpException({ retryAfterSec: Math.ceil(pttl1 / 1000) }, 429);
    }

    // 2. Acquire single-flight lock (atomic SET NX EX).
    const ok = await this.redis.set(this.lockKey(wallet), '1', 'EX', LOCK_TTL_SEC, 'NX');
    if (ok !== 'OK') {
      const ttl = await this.redis.ttl(this.lockKey(wallet));
      throw new HttpException({ retryAfterSec: Math.max(1, ttl) }, 429);
    }

    try {
      // 3. Re-check inside lock to close the check-then-act race.
      const pttl2 = await this.redis.pttl(this.claimedKey(wallet));
      if (pttl2 > 0) {
        throw new HttpException({ retryAfterSec: Math.ceil(pttl2 / 1000) }, 429);
      }

      // 4. Build & send transaction.
      let signature: string;
      let ata: PublicKey;
      try {
        ({ signature, ata } = await this.buildAndSubmit(wallet, dripAmount));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        this.logger.error(`Faucet tx failed: wallet=${wallet} ${msg}`, stack);
        throw new InternalServerErrorException('Faucet request failed');
      }

      // 5. Mark consumed (only after success).
      await this.redis.set(this.claimedKey(wallet), signature, 'EX', RATE_LIMIT_TTL_SEC);

      this.logger.log(
        `Faucet claim: wallet=${wallet} amount=${dripAmount} ata=${ata.toBase58()} sig=${signature}`,
      );

      return {
        success: true,
        signature,
        ata: ata.toBase58(),
        amount: dripAmount,
      };
    } finally {
      // 6. Always release the lock.
      await this.redis.del(this.lockKey(wallet));
    }
  }

  /**
   * Inner helper — keeps the claim() control flow readable. Throws on
   * any RPC / serialisation failure; the outer method catches and
   * collapses to a 500 with a clean client-facing message.
   */
  private async buildAndSubmit(
    wallet: string,
    dripAmount: number,
  ): Promise<{ signature: string; ata: PublicKey }> {
    const authority = this.authority!;
    const funder = this.funder!;

    const ownerPk = new PublicKey(wallet);
    const ata = findAta(ownerPk, this.mintPk);
    const ixs: TransactionInstruction[] = [];

    const ataInfo = await this.connection.getAccountInfo(ata);
    if (!ataInfo) {
      ixs.push(buildCreateAtaIx(funder.publicKey, ownerPk, this.mintPk));
    }

    const lamports = await this.connection.getBalance(ownerPk);
    if (lamports === 0) {
      ixs.push(
        SystemProgram.transfer({
          fromPubkey: funder.publicKey,
          toPubkey: ownerPk,
          lamports: MIN_FUNDING_LAMPORTS,
        }),
      );
    }

    const amountBase = BigInt(dripAmount) * BigInt(10) ** BigInt(USDC_DECIMALS);
    ixs.push(buildMintToIx(authority.publicKey, this.mintPk, ata, amountBase));

    const tx = new Transaction().add(...ixs);
    tx.feePayer = funder.publicKey;
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    // Funder is the fee payer and must sign first; authority signs the
    // mint instruction. `tx.sign` is order-tolerant — it matches
    // signatures by pubkey — but we keep the documented order for
    // readability.
    tx.sign(funder, authority);

    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );

    return { signature, ata };
  }
}
