import {
  BadRequestException,
  HttpException,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  DEFAULT_EARN_USDC_AMOUNT,
  EARN_USDC_DECIMALS,
  LOCK_TTL_SEC,
  MIN_FUNDING_LAMPORTS,
  RATE_LIMIT_TTL_SEC,
  resolveEarnUsdcMint,
} from './faucet.constants.js';
import { FAUCET_REDIS } from './redis.provider.js';
import { FAUCET_EARN_USDC_AUTHORITY_KEYPAIR, FAUCET_FUNDER_KEYPAIR } from './keypair.tokens.js';
import { buildCreateAtaIx, buildMintToIx, findAta } from './spl/spl-ix.js';

/**
 * Devnet/localnet earn-USDC faucet.
 *
 * Structurally identical to `FaucetService` (the localnet USDC faucet): the
 * earn deployer HOLDS the mint authority of the earn USDC mint, so this faucet
 * uses **MintTo** (mint-from-thin-air) rather than the treasury Transfer the
 * RWT faucet uses. There is no treasury to refill.
 *
 * The earn USDC mint is a SEPARATE mint from the main-app USDC — it is pinned
 * in `faucet.constants.ts` (`EARN_USDC_MINT_PUBKEY`, overridable via
 * `FAUCET_EARN_USDC_MINT`) and deliberately NOT sourced from `@areal/sdk`.
 *
 * Lifecycle of a single claim (`POST /faucet/earn-usdc`):
 *   1. Pre-check: if the wallet has a live `faucet:earn-usdc:claimed:<wallet>`
 *      key, 429.
 *   2. Acquire `faucet:earn-usdc:lock:<wallet>` (SET NX EX, 30s). If already
 *      held, 429.
 *   3. Re-check claim mark inside the lock — guards the check-then-act race
 *      when two requests pass step 1 in parallel.
 *   4. Build & submit the transaction:
 *        - Optional: create the recipient's earn-USDC ATA if missing
 *          (payer = funder keypair, same one the other faucets use).
 *        - Optional: airdrop ~0.05 SOL if the recipient has zero balance,
 *          so they can pay rent for follow-up txs.
 *        - Always: MintTo (earn deployer / authority signs).
 *   5. On confirmed signature, set `faucet:earn-usdc:claimed:<wallet> = signature`
 *      with a 24h TTL.
 *   6. Always release the lock.
 *
 * Error policy / logger discipline: identical to the other faucet services.
 * Never log keypair objects, secret bytes, or the full `error` value.
 *
 * Boot-time keypair pin: handled in `faucet.module.ts` —
 * `buildEarnUsdcAuthorityKeypair` returns `null` on any non-devnet/localnet
 * cluster, and asserts the keypair matches the expected earn authority pubkey
 * (env-supplied or fallback constant). Reaching `claimEarnUsdc` with a null
 * authority indicates a misconfigured deployment — fail closed with 404.
 */
@Injectable()
export class EarnUsdcFaucetService {
  private readonly logger = new Logger(EarnUsdcFaucetService.name);
  private readonly mintPk: PublicKey;

  constructor(
    @Inject(SOLANA_CONNECTION) private readonly connection: Connection,
    @Inject(FAUCET_REDIS) private readonly redis: Redis,
    @Inject(FAUCET_EARN_USDC_AUTHORITY_KEYPAIR) private readonly authority: Keypair | null,
    @Inject(FAUCET_FUNDER_KEYPAIR) private readonly funder: Keypair | null,
    config: ConfigService,
  ) {
    // Mint pubkey is resolved once at construction: env override
    // (`FAUCET_EARN_USDC_MINT`) > pinned literal. Parsed eagerly so a malformed
    // override surfaces at boot, not on the first claim.
    this.mintPk = new PublicKey(resolveEarnUsdcMint(config.get<string>('faucet.earnUsdcMint')));
  }

  private claimedKey(wallet: string): string {
    return `faucet:earn-usdc:claimed:${wallet}`;
  }

  private lockKey(wallet: string): string {
    return `faucet:earn-usdc:lock:${wallet}`;
  }

  async claimEarnUsdc(wallet: string, amount?: number): Promise<FaucetClaimResponseDto> {
    // The devnet/localnet guard 404s before this method on any other cluster,
    // so reaching this branch with a null keypair indicates a misconfigured
    // deployment — fail closed.
    if (!this.authority || !this.funder) {
      throw new NotFoundException();
    }

    const dripAmount = amount ?? DEFAULT_EARN_USDC_AMOUNT;

    // 0. Reject off-curve recipients up-front (defense against the
    //    rate-limit-rotation drain: a caller submitting a fresh PDA-shape
    //    "wallet" each call would otherwise burn SOL + earn-USDC into an
    //    account no one can sign for, and bypass the per-wallet 24h cap by
    //    varying the pubkey).
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
        this.logger.error(`Faucet earn-USDC tx failed: wallet=${wallet} ${msg}`, stack);
        throw new InternalServerErrorException('Faucet request failed');
      }

      // 5. Mark consumed (only after success).
      await this.redis.set(this.claimedKey(wallet), signature, 'EX', RATE_LIMIT_TTL_SEC);

      this.logger.log(
        `Faucet earn-USDC claim: wallet=${wallet} amount=${dripAmount} ata=${ata.toBase58()} sig=${signature}`,
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
   * Inner helper — identical shape to `FaucetService.buildAndSubmit`: optional
   * ATA-create + optional 0.05 SOL drip + MintTo signed by the earn authority.
   * The funder is the fee payer (and the ATA-create payer if needed); the
   * authority signs the MintTo. Both must sign for the tx to land.
   */
  private async buildAndSubmit(
    ownerPk: PublicKey,
    dripAmount: number,
  ): Promise<{ signature: string; ata: PublicKey }> {
    const authority = this.authority!;
    const funder = this.funder!;

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

    const amountBase = BigInt(dripAmount) * BigInt(10) ** BigInt(EARN_USDC_DECIMALS);
    ixs.push(buildMintToIx(authority.publicKey, this.mintPk, ata, amountBase));

    const tx = new Transaction().add(...ixs);
    tx.feePayer = funder.publicKey;
    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash('confirmed');
    tx.recentBlockhash = blockhash;
    // Funder pays fees + creates ATA if needed; authority signs the MintTo.
    // `tx.sign` is order-tolerant — it matches signatures by pubkey — but we
    // keep the documented order for readability.
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
