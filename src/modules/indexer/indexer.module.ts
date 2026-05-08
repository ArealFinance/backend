import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Event } from '../../entities/event.entity.js';
import { ProjectionsModule } from '../projections/projections.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { BackfillService } from './backfill.service.js';
import { ChainListenerService } from './chain-listener.service.js';
import { DecoderService } from './decoder.service.js';
import { INDEXER_QUEUE_NAME } from './dto/event-job.dto.js';
import { IndexerConsumer } from './indexer.consumer.js';
import { PersisterService } from './persister.service.js';
import { ReconcileService } from './reconcile.service.js';

/**
 * Indexer module — owns chain listening, persistence, backfill, reconciliation.
 *
 * Note: the Solana `Connection` provider used to live here. As of R-12.3.1-3
 * it has been promoted to the `@Global` `SolanaConnectionModule` under
 * `common/solana/` so other features (markets, health, …) can inject it
 * without depending on the indexer.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Event]),
    BullModule.registerQueue({ name: INDEXER_QUEUE_NAME }),
    ProjectionsModule,
    RealtimeModule,
  ],
  providers: [
    DecoderService,
    PersisterService,
    ChainListenerService,
    ReconcileService,
    BackfillService,
    IndexerConsumer,
  ],
  exports: [DecoderService, PersisterService],
})
export class IndexerModule {}
