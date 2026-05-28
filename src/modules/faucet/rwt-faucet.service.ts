import {
  BadRequestException,
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
  DEFAULT_RWT_AMOUNT,
  LOCK_TTL_SEC,
  MIN_FUNDING_LAMPORTS,
  RATE_LIMIT_TTL_SEC,
  RWT_DECIMALS,
  RWT_MINT_PUBKEY,
} from './faucet.constants.js';
import { FAUCET_REDIS } from './redis.provider.js';
import { FAUCET_FUNDER_KEYPAIR, FAUCET_RWT_TREASURY_KEYPAIR } from './keypair.tokens.js';
import { buildCreateAtaIx, buildTransferIx, findAta } from './spl/spl-ix.js';

/**
 * Devnet test-RWT faucet.
 *
 * Mirrors the USDC faucet lifecycle but uses SPL **Transfer** from a
 * pre-funded treasury ATA instead of MintTo, because the RWT mint
 * authority lives on-chain in the RWT engine PDA (not the deployer).
 *
 * Lifecycle of a single claim (`POST /faucet/rwt`):
 *   1. Pre-check: if the wallet has a live `faucet:rwt:claimed:<wallet>`
 *      key, 429.
 *   2. Acquire `faucet:rwt:lock:<wallet>` (SET NX EX, 30s). If already
 *      held, 429.
 *   3. Re-check claim mark inside the lock — guards the check-then-act
 *      race when two requests pass step 1 in parallel.
 *   4. Build & submit the transaction:
 *        - Optional: create the recipient's RWT ATA if missing
 *          (payer = funder keypair, same one the USDC faucet uses).
 *        - Optional: airdrop ~0.05 SOL if the recipient has zero balance,
 *          so they can pay rent for follow-up txs.
 *        - Always: SPL Transfer from treasuryAta → recipientAta, signed
 *          by the treasury keypair.
 *   5. On confirmed signature, set `faucet:rwt:claimed:<wallet> = signature`
 *      with a 24h TTL.
 *   6. Always release the lock.
 *
 * Error policy / logger discipline: identical to the USDC service. Never
 * log keypair objects, secret bytes, or the full `error` value.
 *
 * Boot-time keypair pin: handled in `faucet.module.ts` —
 * `buildRwtTreasuryKeypair` returns `null` on any non-devnet/localnet
 * cluster, and asserts the keypair matches the expected treasury pubkey
 * (env-supplied or fallback constant). Reaching `claimRwt` with a null
 * treasury indicates a misconfigured deployment — fail closed with 404.
 */
@Injectable()
export class RwtFaucetService {
  private readonly logger = new Logger(RwtFaucetService.name);
  private readonly mintPk = new PublicKey(RWT_MINT_PUBKEY);

  constructor(
    @Inject(SOLANA_CONNECTION) private readonly connection: Connection,
    @Inject(FAUCET_REDIS) private readonly redis: Redis,
    @Inject(FAUCET_RWT_TREASURY_KEYPAIR) private readonly treasury: Keypair | null,
    @Inject(FAUCET_FUNDER_KEYPAIR) private readonly funder: Keypair | null,
  ) {}

  private claimedKey(wallet: string): string {
    return `faucet:rwt:claimed:${wallet}`;
  }

  private lockKey(wallet: string): string {
    return `faucet:rwt:lock:${wallet}`;
  }

  async claimRwt(wallet: string, amount?: number): Promise<FaucetClaimResponseDto> {
    // The devnet/localnet guard 404s before this method on any other
    // cluster, so reaching this branch with a null keypair indicates a
    // misconfigured deployment — fail closed.
    if (!this.treasury || !this.funder) {
      throw new NotFoundException();
    }

    const dripAmount = amount ?? DEFAULT_RWT_AMOUNT;

    // 0. Reject off-curve recipients up-front (defense against the
    //    rate-limit-rotation drain: a caller submitting a fresh
    //    PDA-shape "wallet" each call would otherwise burn SOL +
    //    test-RWT into an account no one can sign for, and bypass
    //    the per-wallet 24h cap by varying the pubkey).
    let ownerPk: PublicKey;
    try {
      ownerPk = new PublicKey(wallet);
    } catch {
      throw new BadRequestException('invalid base58 pubkey');
    }
    if (!PublicKey.isOnCurve(ownerPk.toBytes())) {
      throw new BadRequestException('wallet must be an on-curve account (no PDAs)');
    }

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
        ({ signature, ata } = await this.buildAndSubmit(ownerPk, dripAmount));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        const stack = error instanceof Error ? error.stack : undefined;
        this.logger.error(`Faucet RWT tx failed: wallet=${wallet} ${msg}`, stack);
        throw new InternalServerErrorException('Faucet request failed');
      }

      // 5. Mark consumed (only after success).
      await this.redis.set(this.claimedKey(wallet), signature, 'EX', RATE_LIMIT_TTL_SEC);

      this.logger.log(
        `Faucet RWT claim: wallet=${wallet} amount=${dripAmount} ata=${ata.toBase58()} sig=${signature}`,
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
   * Inner helper — same shape as `FaucetService.buildAndSubmit` but
   * uses SPL Transfer from the treasury ATA instead of MintTo. The
   * funder remains the fee payer (and the ATA-create payer if needed),
   * the treasury signs the Transfer. Both must sign for the tx to land.
   */
  private async buildAndSubmit(
    ownerPk: PublicKey,
    dripAmount: number,
  ): Promise<{ signature: string; ata: PublicKey }> {
    const treasury = this.treasury!;
    const funder = this.funder!;

    const recipientAta = findAta(ownerPk, this.mintPk);
    const treasuryAta = findAta(treasury.publicKey, this.mintPk);
    const ixs: TransactionInstruction[] = [];

    const recipientAtaInfo = await this.connection.getAccountInfo(recipientAta);
    if (!recipientAtaInfo) {
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

    const amountBase = BigInt(dripAmount) * BigInt(10) ** BigInt(RWT_DECIMALS);
    ixs.push(
      buildTransferIx({
        source: treasuryAta,
        destination: recipientAta,
        owner: treasury.publicKey,
        amountBase,
      }),
    );

    const tx = new Transaction().add(...ixs);
    tx.feePayer = funder.publicKey;
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    // Funder pays fees + creates ATA if needed; treasury signs the
    // SPL Transfer. `tx.sign` is order-tolerant — it matches signatures
    // by pubkey — but we keep the documented order for readability.
    tx.sign(funder, treasury);

    const signature = await this.connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    });
    await this.connection.confirmTransaction(
      { signature, blockhash, lastValidBlockHeight },
      'confirmed',
    );

    return { signature, ata: recipientAta };
  }
}
