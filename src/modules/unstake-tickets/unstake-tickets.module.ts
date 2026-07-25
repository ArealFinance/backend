import { Module } from '@nestjs/common';

import { UnstakeTicketsController } from './unstake-tickets.controller.js';
import { UnstakeTicketsService } from './unstake-tickets.service.js';

/**
 * Read-only mainnet UnstakeTicket query. `SOLANA_CONNECTION` is provided by
 * the global SolanaConnectionModule registered at the application root.
 */
@Module({
  controllers: [UnstakeTicketsController],
  providers: [UnstakeTicketsService],
})
export class UnstakeTicketsModule {}
