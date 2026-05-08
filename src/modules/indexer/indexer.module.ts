import { BullModule } from '@nestjs/bull';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Event } from '../../entities/event.entity.js';
import { ProjectionsModule } from '../projections/projections.module.js';
import { BackfillService } from './backfill.service.js';
import { ChainListenerService } from './chain-listener.service.js';
import { connectionProvider } from './connection.provider.js';
import { DecoderService } from './decoder.service.js';
import { INDEXER_QUEUE_NAME } from './dto/event-job.dto.js';
import { IndexerConsumer } from './indexer.consumer.js';
import { PersisterService } from './persister.service.js';
import { ReconcileService } from './reconcile.service.js';

@Module({
  imports: [
    TypeOrmModule.forFeature([Event]),
    BullModule.registerQueue({ name: INDEXER_QUEUE_NAME }),
    ProjectionsModule,
  ],
  providers: [
    connectionProvider,
    DecoderService,
    PersisterService,
    ChainListenerService,
    ReconcileService,
    BackfillService,
    IndexerConsumer,
  ],
  exports: [DecoderService, PersisterService, connectionProvider],
})
export class IndexerModule {}
