import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ClaimHistory } from '../../entities/claim-history.entity.js';
import { LpPositionHistory } from '../../entities/lp-position-history.entity.js';
import { PortfolioController } from './portfolio.controller.js';
import { PortfolioService } from './portfolio.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([ClaimHistory, LpPositionHistory])],
  controllers: [PortfolioController],
  providers: [PortfolioService],
})
export class PortfolioModule {}
