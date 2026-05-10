import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { SolanaCluster } from '../../config/configuration.js';

/**
 * Hard-gate the faucet endpoint to localnet. On any other cluster the
 * route MUST be invisible — we throw `NotFoundException` (not Forbidden)
 * so a curious caller sees a generic 404 instead of confirming the
 * route exists. Pairs with the module-level keypair guard that returns
 * `null` keypairs outside of localnet.
 */
@Injectable()
export class LocalnetOnlyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(_context: ExecutionContext): boolean {
    const cluster = this.configService.get<SolanaCluster>('solana.cluster');
    if (cluster !== 'localnet') {
      throw new NotFoundException();
    }
    return true;
  }
}
