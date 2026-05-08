import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { TypeOrmModule } from '@nestjs/typeorm';

import { RefreshToken } from '../../entities/refresh-token.entity.js';
import { User } from '../../entities/user.entity.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { authRedisProvider } from './redis.provider.js';
import { JwtStrategy } from './strategies/jwt.strategy.js';

/**
 * Service-identity claims stamped into every Areal-issued JWT
 * (R-12.3.1-7). Pinning issuer + audience at sign + verify time prevents
 * a future service that happens to share `JWT_SECRET` from minting tokens
 * accepted by `/auth` or `/realtime`. Treat these as part of the wire
 * contract — bumping them invalidates every currently-issued token.
 */
export const JWT_ISSUER = 'areal-backend';
export const JWT_AUDIENCE = 'areal-api';

@Module({
  imports: [
    TypeOrmModule.forFeature([User, RefreshToken]),
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService): JwtModuleOptions => {
        // Defensive double-check: configuration.ts already throws when
        // JWT_SECRET is missing, but a misconfigured load() callback
        // could still hand us an empty value. Surface it loudly at
        // module init rather than later at first-request.
        const secret = config.get<string>('jwt.secret');
        if (!secret) {
          throw new Error(
            'jwt.secret is empty at AuthModule init — JWT_SECRET must be set before boot',
          );
        }
        return {
          // `expiresIn` in `@nestjs/jwt` v11 is typed as `number | ms.StringValue`
          // — a literal-string union the env-derived `string` doesn't satisfy.
          // We validate the grammar ourselves in `parseTtlSeconds` and cast at
          // the boundary; an invalid value falls back to the JWT lib default
          // rather than throwing at module init.
          secret,
          signOptions: {
            expiresIn: (config.get<string>('jwt.expiresIn') ?? '7d') as `${number}d`,
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
          },
          // Mirror of `signOptions` so `JwtService.verifyAsync` rejects
          // tokens missing or mismatched on iss/aud — picked up by
          // `JwtStrategy` (REST) and `RealtimeGateway` (WS handshake).
          verifyOptions: {
            issuer: JWT_ISSUER,
            audience: JWT_AUDIENCE,
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, authRedisProvider],
  // JwtModule is re-exported so consumers (e.g. RealtimeModule's WS
  // handshake gate in Phase 12.3.1) can `JwtService.verifyAsync` against
  // the same secret/options as the REST auth flow.
  exports: [AuthService, JwtStrategy, JwtModule, PassportModule],
})
export class AuthModule {}
