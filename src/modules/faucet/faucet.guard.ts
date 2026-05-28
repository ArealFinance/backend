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

/**
 * Hard-gate the RWT faucet endpoint to devnet or localnet. Mainnet
 * MUST 404 — same 404-not-Forbidden discipline as `LocalnetOnlyGuard`,
 * and same pair with the module-level keypair guard that returns `null`
 * outside the allowed clusters.
 *
 * Localnet is included so a local dev stack can exercise the RWT path
 * without standing up devnet, provided the operator wires
 * `FAUCET_RWT_TREASURY_KEYPAIR_B64` for the local deployer.
 */
@Injectable()
export class DevnetOrLocalnetGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(_context: ExecutionContext): boolean {
    const cluster = this.configService.get<SolanaCluster>('solana.cluster');
    if (cluster !== 'devnet' && cluster !== 'localnet') {
      throw new NotFoundException();
    }
    return true;
  }
}
