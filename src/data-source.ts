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

import { Event } from './entities/event.entity.js';
import { RefreshToken } from './entities/refresh-token.entity.js';
import { User } from './entities/user.entity.js';
import { InitSchema0001 } from './migrations/0001-init.js';
import { FixEventUniqueness0002 } from './migrations/0002-fix-event-uniqueness.js';

dotenv.config({ path: ['.env.local', '.env'] });

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  schema: 'areal',
  synchronize: false,
  logging: process.env.TYPEORM_LOGGING === 'true',
  entities: [Event, User, RefreshToken],
  migrations: [InitSchema0001, FixEventUniqueness0002],
  migrationsTableName: 'typeorm_migrations',
});
