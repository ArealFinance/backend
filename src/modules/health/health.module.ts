import { Module } from '@nestjs/common';

import { IndexerModule } from '../indexer/indexer.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [IndexerModule],
  controllers: [HealthController],
})
export class HealthModule {}
