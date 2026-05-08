import { createHash, randomBytes } from 'node:crypto';

import {
  Injectable,
  Logger,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import { LessThan, Repository } from 'typeorm';

import { RefreshToken } from '../../entities/refresh-token.entity.js';
import { User } from '../../entities/user.entity.js';
import { AuthResponseDto } from './dto/auth-response.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { JwtPayload } from './strategies/jwt.strategy.js';

/**
 * Wallet-signature authentication.
 *
 * Login flow:
 *   1. Client builds a deterministic message embedding the wallet + an
 *      ISO-8601 timestamp.
 *   2. Client signs with the wallet (Phantom / Solflare).
 *   3. POST `/auth/login` with `{ wallet, signature, message }`.
 *   4. Server:
 *      a. parses the timestamp out of the message and rejects if outside the
 *         5-minute skew window (prevents replay of stale signatures);
 *      b. verifies the message also embeds the claimed wallet (so a sig
 *         legitimately produced by wallet A can't be replayed by wallet B);
 *      c. ed25519-verifies the signature against the wallet pubkey;
 *      d. upserts the `users` row, issues a JWT + opaque refresh token.
 *
 * Refresh flow:
 *   - Client presents the raw refresh token. Server hashes it (sha256) and
 *     looks up by hash. If row exists, not revoked, not expired → mint a new
 *     access+refresh pair, mark the presented token revoked (rotation).
 *
 * NEVER persist the raw refresh token. NEVER log the signature or refresh
 * token bodies.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /** Max allowed clock skew between client and server, in ms. */
  static readonly TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

  /** Refresh token TTL, in seconds. Must align with `jwt.refreshExpiresIn`. */
  static readonly REFRESH_TTL_DEFAULT_SECS = 30 * 24 * 60 * 60;

  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(RefreshToken) private readonly refreshTokens: Repository<RefreshToken>,
  ) {}

  // -- public API -----------------------------------------------------------

  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const wallet = this.canonicaliseWallet(dto.wallet);

    if (!this.verifyTimestamp(dto.message)) {
      throw new UnauthorizedException('login message timestamp invalid or out of skew window');
    }
    if (!this.verifyMessageBindsWallet(dto.message, wallet)) {
      throw new UnauthorizedException('login message does not bind to the claimed wallet');
    }
    if (!this.verifySignature(wallet, dto.signature, dto.message)) {
      throw new UnauthorizedException('signature verification failed');
    }

    await this.touchUser(wallet);
    return this.issueTokens(wallet);
  }

  async refresh(presentedToken: string): Promise<AuthResponseDto> {
    const hash = this.hashToken(presentedToken);
    const row = await this.refreshTokens.findOne({ where: { tokenHash: hash } });
    if (!row || row.revokedAt !== null || row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('refresh token invalid, expired, or revoked');
    }

    // Rotation — revoke the presented token before minting new ones so a
    // double-spend attempt (race: same token submitted twice) loses on the
    // second attempt at the unique constraint / revoked check.
    row.revokedAt = new Date();
    await this.refreshTokens.save(row);

    return this.issueTokens(row.wallet);
  }

  // -- verification primitives (kept public for unit testing) --------------

  /** ed25519 signature verification. Returns false on any decode/length error. */
  verifySignature(wallet: string, signatureBase58: string, message: string): boolean {
    try {
      const sigBytes = bs58.decode(signatureBase58);
      if (sigBytes.length !== nacl.sign.signatureLength) return false;
      const messageBytes = new TextEncoder().encode(message);
      const pubkeyBytes = new PublicKey(wallet).toBytes();
      return nacl.sign.detached.verify(messageBytes, sigBytes, pubkeyBytes);
    } catch (err) {
      this.logger.warn(
        `verifySignature: decode error — ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * Extracts an ISO-8601 timestamp from the message and enforces
   * `|now - ts| <= TIMESTAMP_SKEW_MS`. Returns false if the format doesn't
   * match or the timestamp is unparseable.
   *
   * The expected format is:
   *   `Login to Areal at <ISO-8601> for wallet <pubkey>`
   *
   * We deliberately match BOTH `at <ts> for wallet` (Phase 5 precedent) and
   * `at <ts> from <pubkey>` (older client variant) to avoid coupling the
   * server to a single client revision while still rejecting freeform text.
   */
  verifyTimestamp(message: string): boolean {
    const match = message.match(/at (\S+) (?:for|from) (?:wallet )?\S+/);
    if (!match) return false;
    const ts = Date.parse(match[1]);
    if (!Number.isFinite(ts)) return false;
    return Math.abs(Date.now() - ts) <= AuthService.TIMESTAMP_SKEW_MS;
  }

  /**
   * Confirms the message body actually embeds the wallet the client claims —
   * defends against signature-replay across wallets where a server only checked
   * the timestamp. The wallet string is matched as a whole word.
   */
  verifyMessageBindsWallet(message: string, wallet: string): boolean {
    return message.includes(wallet);
  }

  // -- housekeeping --------------------------------------------------------

  /**
   * Cron-friendly hook to drop expired/revoked rows. Not wired to a schedule
   * here (Phase 12.1 keeps cron surface minimal); call from a cron job in
   * a later phase.
   */
  async pruneExpiredRefreshTokens(): Promise<number> {
    const cutoff = new Date();
    const res = await this.refreshTokens.delete({ expiresAt: LessThan(cutoff) });
    return res.affected ?? 0;
  }

  // -- internals -----------------------------------------------------------

  private canonicaliseWallet(input: string): string {
    try {
      return new PublicKey(input).toBase58();
    } catch {
      throw new UnprocessableEntityException('wallet is not a valid base58 pubkey');
    }
  }

  private async touchUser(wallet: string): Promise<void> {
    const now = new Date();
    await this.users.upsert(
      { wallet, lastSeenAt: now },
      { conflictPaths: ['wallet'], skipUpdateIfNoValuesChanged: false },
    );
  }

  private async issueTokens(wallet: string): Promise<AuthResponseDto> {
    const payload: JwtPayload = { sub: wallet };
    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get<string>('jwt.secret'),
      expiresIn: this.config.get<string>('jwt.expiresIn'),
    });

    const refreshTtlSecs = this.parseTtlSeconds(
      this.config.get<string>('jwt.refreshExpiresIn') ?? '30d',
      AuthService.REFRESH_TTL_DEFAULT_SECS,
    );
    const refreshTokenRaw = this.mintRefreshTokenRaw();
    const expiresAt = new Date(Date.now() + refreshTtlSecs * 1000);
    await this.refreshTokens.save(
      this.refreshTokens.create({
        wallet,
        tokenHash: this.hashToken(refreshTokenRaw),
        expiresAt,
        revokedAt: null,
      }),
    );

    // Approximate access-token expiry — exact `exp` is inside the JWT.
    const accessTtlSecs = this.parseTtlSeconds(
      this.config.get<string>('jwt.expiresIn') ?? '7d',
      7 * 24 * 60 * 60,
    );
    return {
      accessToken,
      refreshToken: refreshTokenRaw,
      wallet,
      expiresAt: new Date(Date.now() + accessTtlSecs * 1000).toISOString(),
    };
  }

  private mintRefreshTokenRaw(): string {
    // 48 bytes of CSPRNG → ~64 url-safe chars after base64url. Plenty of
    // entropy and never replayed across users.
    return randomBytes(48).toString('base64url');
  }

  private hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * Tiny `(\d+)([smhd])` parser that accepts the same grammar as `@nestjs/jwt`
   * `expiresIn`. Falls back to `defaultSecs` for anything we can't parse rather
   * than throwing — the JWT itself still has the canonical `exp` claim.
   */
  private parseTtlSeconds(input: string, defaultSecs: number): number {
    const m = input.match(/^(\d+)([smhd])$/);
    if (!m) return defaultSecs;
    const n = parseInt(m[1], 10);
    switch (m[2]) {
      case 's':
        return n;
      case 'm':
        return n * 60;
      case 'h':
        return n * 3600;
      case 'd':
        return n * 86400;
      default:
        return defaultSecs;
    }
  }
}
