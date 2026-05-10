import { Logger, Module, type FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Keypair } from '@solana/web3.js';

import type { SolanaCluster } from '../../config/configuration.js';
import { FaucetController } from './faucet.controller.js';
import { FaucetService } from './faucet.service.js';
import { EXPECTED_AUTHORITY } from './faucet.constants.js';
import { FAUCET_AUTHORITY_KEYPAIR, FAUCET_FUNDER_KEYPAIR } from './keypair.tokens.js';
import { faucetRedisProvider } from './redis.provider.js';
import { loadKeypairFromB64Env } from './spl/keypair-loader.js';

/**
 * Faucet module — ALWAYS registered in `AppModule`. The cluster gate
 * lives at two layers:
 *   - `LocalnetOnlyGuard` on the controller route: 404 outside localnet.
 *   - The keypair providers below: return `null` outside localnet, so
 *     even an internal caller of `FaucetService.claim` (e.g. a future
 *     job) can't bypass the guard and mint test-USDC against a real
 *     mint by accident.
 *
 * On localnet, the authority keypair is asserted to match the
 * bootstrap-pinned `EXPECTED_AUTHORITY` pubkey. This catches the
 * dangerous misconfig where an operator pastes a real-mint authority
 * keypair into the localnet env block.
 */

const authorityKeypairProvider: FactoryProvider<Keypair | null> = {
  provide: FAUCET_AUTHORITY_KEYPAIR,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Keypair | null => {
    const cluster = config.get<SolanaCluster>('solana.cluster');
    if (cluster !== 'localnet') return null;
    const logger = new Logger('FaucetModule');
    const kp = loadKeypairFromB64Env(
      'FAUCET_USDC_AUTHORITY_KEYPAIR_B64',
      'FAUCET_USDC_AUTHORITY',
      config,
    );
    const actual = kp.publicKey.toBase58();
    if (actual !== EXPECTED_AUTHORITY) {
      throw new Error(
        `FAUCET_USDC_AUTHORITY pubkey mismatch: expected ${EXPECTED_AUTHORITY}, got ${actual} — refusing to boot`,
      );
    }
    logger.log(`Faucet USDC authority loaded: ${actual}`);
    return kp;
  },
};

const funderKeypairProvider: FactoryProvider<Keypair | null> = {
  provide: FAUCET_FUNDER_KEYPAIR,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Keypair | null => {
    const cluster = config.get<SolanaCluster>('solana.cluster');
    if (cluster !== 'localnet') return null;
    const logger = new Logger('FaucetModule');
    const kp = loadKeypairFromB64Env(
      'FAUCET_SOL_FUNDER_KEYPAIR_B64',
      'FAUCET_SOL_FUNDER',
      config,
    );
    logger.log(`Faucet SOL funder loaded: ${kp.publicKey.toBase58()}`);
    return kp;
  },
};

@Module({
  controllers: [FaucetController],
  providers: [
    FaucetService,
    faucetRedisProvider,
    authorityKeypairProvider,
    funderKeypairProvider,
  ],
})
export class FaucetModule {}
