import { ExecutionContext, createParamDecorator } from '@nestjs/common';

/**
 * Pulls the authenticated wallet pubkey off the request, populated by
 * `JwtStrategy.validate`. Use in controllers behind `@UseGuards(JwtAuthGuard)`:
 *
 *   @Get('me')
 *   me(@CurrentWallet() wallet: string) { ... }
 *
 * Returns the base58 pubkey string. Will be `undefined` if the route is not
 * protected — by design, so misuse fails loudly rather than masquerading as
 * the empty string.
 */
export interface AuthenticatedRequest {
  user?: { wallet: string };
}

export const CurrentWallet = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined => {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return req.user?.wallet;
  },
);
