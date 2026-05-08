import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

export interface JwtPayload {
  /** Subject — base58 wallet pubkey. */
  sub: string;
  iat?: number;
  exp?: number;
}

/**
 * Standard `passport-jwt` strategy validating the `Authorization: Bearer <jwt>`
 * header. The validated payload is attached to `request.user` as
 * `{ wallet }` — read it via `@CurrentWallet()`.
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
    });
  }

  async validate(payload: JwtPayload): Promise<{ wallet: string }> {
    if (!payload?.sub || typeof payload.sub !== 'string') {
      throw new UnauthorizedException('invalid token payload');
    }
    return { wallet: payload.sub };
  }
}
