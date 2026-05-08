/**
 * TypeORM data source for the **CLI** (migrations).
 *
 * Runtime DB access lives inside `app.module.ts` via `TypeOrmModule.forRootAsync`.
 * This file is consumed exclusively by the typeorm CLI invoked via
 * `node --loader ts-node/esm node_modules/typeorm/cli.js migration:*` — keep
 * it in sync with the runtime config or migrations will drift from the live
 * schema.
 *
 * NEVER set `synchronize: true` here. Migrations are the only path to schema
 * change in this project (production safety).
 */
import 'reflect-metadata';
import dotenv from 'dotenv';
import { DataSource } from 'typeorm';

import { ClaimHistory } from './entities/claim-history.entity.js';
import { DailyPoolAggregate } from './entities/daily-pool-aggregate.entity.js';
import { Event } from './entities/event.entity.js';
import { LpPositionHistory } from './entities/lp-position-history.entity.js';
import { PoolSnapshot } from './entities/pool-snapshot.entity.js';
import { ProtocolSummary } from './entities/protocol-summary.entity.js';
import { RefreshToken } from './entities/refresh-token.entity.js';
import { RevenueDistribution } from './entities/revenue-distribution.entity.js';
import { Transaction } from './entities/transaction.entity.js';
import { User } from './entities/user.entity.js';
import { InitSchema1714780800000 } from './migrations/0001-init.js';
import { FixEventUniqueness1714867200000 } from './migrations/0002-fix-event-uniqueness.js';
import { TightenRefreshTokenHash1714953600000 } from './migrations/0003-tighten-refresh-token-hash.js';
import { ProjectionTables1715040000000 } from './migrations/0004-projection-tables.js';
import { MarketsAggregates1715140000000 } from './migrations/0005-markets-aggregates.js';
import { PoolSnapshotPrices1715140000001 } from './migrations/0006-pool-snapshot-prices.js';
import { RenameDistributorCount1715140000002 } from './migrations/0007-rename-distributor-count.js';

dotenv.config({ path: ['.env.local', '.env'] });

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  schema: 'areal',
  synchronize: false,
  logging: process.env.TYPEORM_LOGGING === 'true',
  entities: [
    Event,
    User,
    RefreshToken,
    Transaction,
    ClaimHistory,
    RevenueDistribution,
    LpPositionHistory,
    PoolSnapshot,
    DailyPoolAggregate,
    ProtocolSummary,
  ],
  migrations: [
    InitSchema1714780800000,
    FixEventUniqueness1714867200000,
    TightenRefreshTokenHash1714953600000,
    ProjectionTables1715040000000,
    MarketsAggregates1715140000000,
    PoolSnapshotPrices1715140000001,
    RenameDistributorCount1715140000002,
  ],
  migrationsTableName: 'typeorm_migrations',
});
