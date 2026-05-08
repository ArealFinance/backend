import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

import { JWT_AUDIENCE, JWT_ISSUER } from '../auth.module.js';

export interface JwtPayload {
  /** Subject — base58 wallet pubkey. */
  sub: string;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string | string[];
}

/**
 * Standard `passport-jwt` strategy validating the `Authorization: Bearer <jwt>`
 * header. The validated payload is attached to `request.user` as
 * `{ wallet }` — read it via `@CurrentWallet()`.
 *
 * As of R-12.3.1-7 the strategy ALSO pins `issuer` + `audience` to the
 * same constants used at sign time, so a token minted by some future
 * service that happens to share `JWT_SECRET` is rejected at the REST
 * boundary even before `validate()` runs.
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    const secret = config.get<string>('jwt.secret');
    if (!secret) {
      throw new Error('JWT_SECRET is required — refusing to start without it');
    }
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: secret,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
  }

  async validate(payload: JwtPayload): Promise<{ wallet: string }> {
    if (!payload?.sub || typeof payload.sub !== 'string') {
      throw new UnauthorizedException('invalid token payload');
    }
    return { wallet: payload.sub };
  }
}
