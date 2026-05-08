import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Transaction } from '../../entities/transaction.entity.js';
import { TransactionsController } from './transactions.controller.js';
import { TransactionsService } from './transactions.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([Transaction])],
  controllers: [TransactionsController],
  providers: [TransactionsService],
})
export class TransactionsModule {}
