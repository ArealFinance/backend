import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection } from '@solana/web3.js';

/**
 * Singleton Solana `Connection` shared by the indexer.
 *
 * One Connection per process is the documented best practice — it owns the
 * websocket subscription pool, and creating multiple Connections to the same
 * RPC fragments subscriptions and burns RPC credit. The websocket URL is
 * derived from the HTTP URL by web3.js automatically when not provided.
 */
export const SOLANA_CONNECTION = Symbol('SOLANA_CONNECTION');

export const connectionProvider: Provider = {
  provide: SOLANA_CONNECTION,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Connection => {
    const rpcUrl = config.get<string>('solana.rpcUrl');
    const wsUrl = config.get<string>('solana.wsUrl');
    if (!rpcUrl) {
      throw new Error('solana.rpcUrl is required — set RPC_URL_<CLUSTER> in env');
    }
    return new Connection(rpcUrl, {
      commitment: 'confirmed',
      wsEndpoint: wsUrl,
    });
  },
};
