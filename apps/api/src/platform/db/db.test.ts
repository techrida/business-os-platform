import 'reflect-metadata';

import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { ConfigModule } from '../config/config.module';
import { DB, DbModule, PG_POOL, inTransaction } from './db.module';

describe('DbModule', () => {
  it('builds a lazy pool and a drizzle db, and closes the pool on shutdown', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          service: 'worker',
          env: {
            DATABASE_URL: 'postgresql://u:p@127.0.0.1:1/bos',
            VALKEY_URL: 'redis://127.0.0.1:1',
          },
        }),
        DbModule,
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const pool = moduleRef.get<{ end: () => Promise<void> }>(PG_POOL);
    const end = vi.spyOn(pool, 'end');
    expect(moduleRef.get(DB)).toBeDefined();
    await app.close();
    expect(end).toHaveBeenCalledOnce();
  });
});

describe('inTransaction', () => {
  it('runs the callback through the db transaction (commit or roll back is drizzle behaviour)', async () => {
    const tx = { marker: 'tx' };
    const db = { transaction: vi.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)) };
    const result = await inTransaction(db as never, (t) => Promise.resolve(t));
    expect(result).toBe(tx);
    expect(db.transaction).toHaveBeenCalledOnce();
  });
});
