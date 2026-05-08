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
import { IsNull, LessThan, Repository } from 'typeorm';

import { RefreshToken } from '../../entities/refresh-token.entity.js';
import { User } from '../../entities/user.entity.js';
import { MetricsService } from '../metrics/metrics.service.js';
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
    private readonly metrics: MetricsService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(RefreshToken) private readonly refreshTokens: Repository<RefreshToken>,
  ) {}

  // -- public API -----------------------------------------------------------

  async login(dto: LoginDto): Promise<AuthResponseDto> {
    // Reject malformed messages early so the structured-field path below can
    // assume a successful parse — keeps the per-step rejection labels clean.
    const parsed = this.verifyMessageStructure(dto.message);
    if (!parsed) {
      this.metrics.authFailures.labels({ reason: 'bad_format' }).inc();
      throw new UnauthorizedException('login message format invalid');
    }

    const wallet = this.canonicaliseWallet(dto.wallet);

    if (!this.verifyTimestamp(dto.message)) {
      this.metrics.authFailures.labels({ reason: 'bad_timestamp' }).inc();
      throw new UnauthorizedException('login message timestamp invalid or out of skew window');
    }
    if (!this.verifyMessageBindsWallet(dto.message, wallet)) {
      this.metrics.authFailures.labels({ reason: 'bad_wallet_binding' }).inc();
      throw new UnauthorizedException('login message does not bind to the claimed wallet');
    }
    if (!this.verifySignature(wallet, dto.signature, dto.message)) {
      this.metrics.authFailures.labels({ reason: 'bad_signature' }).inc();
      throw new UnauthorizedException('signature verification failed');
    }

    await this.touchUser(wallet);
    return this.issueTokens(wallet);
  }

  async refresh(presentedToken: string): Promise<AuthResponseDto> {
    const hash = this.hashToken(presentedToken);

    // Atomic compare-and-set: revoke iff the row exists AND is not yet
    // revoked. Two concurrent calls with the same raw token produce one
    // `affected: 1` (winner) and one `affected: 0` (loser) — there is no
    // window between the read and the write where both branches see the
    // pre-revoked row, which the previous find-then-save did expose.
    const updated = await this.refreshTokens.update(
      { tokenHash: hash, revokedAt: IsNull() },
      { revokedAt: new Date() },
    );

    if (updated.affected !== 1) {
      // Two interesting reasons we'd land here:
      //   1. the hash doesn't match any row (bogus / expired-and-cleaned token),
      //   2. the row exists but is already revoked → REUSE attack (legitimate
      //      client never replays a revoked token; this is bot or theft).
      // For (2) we revoke every still-live token belonging to the same wallet
      // (refresh-token family revoke) so any pair the attacker minted by being
      // faster than the victim is invalidated on next use.
      const reused = await this.refreshTokens.findOne({ where: { tokenHash: hash } });
      if (reused) {
        await this.refreshTokens.update(
          { wallet: reused.wallet, revokedAt: IsNull() },
          { revokedAt: new Date() },
        );
        this.metrics.authFailures.labels({ reason: 'refresh_reuse' }).inc();
        this.logger.warn(
          `refresh-token REUSE detected for ${reused.wallet} — entire family revoked`,
        );
      } else {
        this.metrics.authFailures.labels({ reason: 'refresh_invalid' }).inc();
      }
      throw new UnauthorizedException('refresh token invalid, expired, or revoked');
    }

    // Re-read so we know which wallet to mint tokens for. (The UPDATE above
    // doesn't return the row in a portable way across drivers.)
    const row = await this.refreshTokens.findOne({ where: { tokenHash: hash } });
    if (!row) {
      // Theoretically unreachable — UPDATE just succeeded. Defensive.
      this.metrics.authFailures.labels({ reason: 'refresh_invalid' }).inc();
      throw new UnauthorizedException('refresh token invalid, expired, or revoked');
    }

    // Defence against extremely-long-lived tokens that survived rotation
    // before expiry was enforced — keep the expiry check after rotation.
    if (row.expiresAt.getTime() < Date.now()) {
      this.metrics.authFailures.labels({ reason: 'refresh_invalid' }).inc();
      throw new UnauthorizedException('refresh token invalid, expired, or revoked');
    }

    return this.issueTokens(row.wallet);
  }

  // -- verification primitives (kept public for unit testing) --------------

  /**
   * The exact format we accept for the login message. Anchored at both ends
   * so trailing junk / leading prefixes are rejected (no substring matches).
   *
   * Two client variants are accepted (kept for backward-compat with older
   * clients): `for wallet <pubkey>` (Phase 5 precedent) and `from <pubkey>`
   * (older form). Anything else returns null and the caller responds 401.
   *
   * The wallet capture is restricted to the base58 alphabet (32-44 chars) so
   * a user-controlled message cannot smuggle a `wallet` value containing
   * regex metacharacters, whitespace, or punctuation.
   */
  static readonly LOGIN_MESSAGE_RE =
    /^Login to Areal at (\S+) (?:for wallet|from) ([1-9A-HJ-NP-Za-km-z]{32,44})\s*$/;

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
   * Parse the login message into its declared fields, or return null if the
   * format doesn't match. Public for unit tests; the login flow walks the
   * fields one at a time so future granular metric labelling stays cheap.
   */
  verifyMessageStructure(message: string): { timestamp: string; wallet: string } | null {
    const m = message.match(AuthService.LOGIN_MESSAGE_RE);
    if (!m) return null;
    return { timestamp: m[1]!, wallet: m[2]! };
  }

  /**
   * Extracts the ISO-8601 timestamp from the message and enforces
   * `|now - ts| <= TIMESTAMP_SKEW_MS`. Returns false if the format doesn't
   * match or the timestamp is unparseable.
   *
   * The expected format is:
   *   `Login to Areal at <ISO-8601> for wallet <pubkey>`
   *
   * We deliberately accept both `at <ts> for wallet <pubkey>` (Phase 5
   * precedent) and `at <ts> from <pubkey>` (older client variant) to avoid
   * coupling the server to a single client revision.
   */
  verifyTimestamp(message: string): boolean {
    const parsed = this.verifyMessageStructure(message);
    if (!parsed) return false;
    const ts = Date.parse(parsed.timestamp);
    if (!Number.isFinite(ts)) return false;
    return Math.abs(Date.now() - ts) <= AuthService.TIMESTAMP_SKEW_MS;
  }

  /**
   * Confirms the message body declares the wallet the client claims — defends
   * against signature-replay across wallets. Match is exact (against the
   * structured wallet field) rather than substring — a substring check would
   * accept a malicious message embedding the victim wallet anywhere in
   * arbitrary text alongside a different wallet field.
   */
  verifyMessageBindsWallet(message: string, wallet: string): boolean {
    const parsed = this.verifyMessageStructure(message);
    return parsed?.wallet === wallet;
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
