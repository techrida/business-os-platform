// Exercise the real list handler/service and its generated visibility/search predicates without a server.
// SQLite executes the WHERE clause (ILIKE is rewritten to LIKE, which SQLite matches case-insensitively); the
// typo-tolerant step needs pg_trgm, so these searches stay exact (5+ matches, or under 3 characters) and the
// fuzzy path is covered by the Postgres integration test.
import 'reflect-metadata';

import { DatabaseSync } from 'node:sqlite';

import { customers } from '@bos/db';
import { PgDialect } from 'drizzle-orm/pg-core';
import { type SQL } from 'drizzle-orm';
import { expect, it } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service';
import { can, type Principal } from '../../platform/authz/can';
import { CAN_KEY } from '../../platform/authz/decorators';
import type { Db } from '../../platform/db/db.module';
import type { AuthzService } from '../../platform/authz/authz.service';
import type { NumberingService } from '../../platform/settings/numbering.service';
import { CustomersController } from './customers.controller';
import type { CustomersCaller } from './customers.caller';
import { CustomersService } from './customers.service';

it('searches names with tenant and owner visibility, and requires customer.read', async () => {
  const sqlite = new DatabaseSync(':memory:');
  try {
    sqlite.exec(`ATTACH DATABASE ':memory:' AS app;
    CREATE TABLE app.customers (
      id TEXT, tenant_id TEXT, owner_user_id TEXT, legal_name TEXT,
      name_norm TEXT, pan_vat_no TEXT, number TEXT
    );
    INSERT INTO app.customers VALUES
      ('mine', 'tenant-a', 'user-a', 'Mountain Legal Ltd', 'mountain legal ltd', NULL, 'CUS-1'),
      ('mine-2', 'tenant-a', 'user-a', 'Mountain Two Ltd', 'mountain two ltd', NULL, 'CUS-4'),
      ('mine-3', 'tenant-a', 'user-a', 'Mountain Three Ltd', 'mountain three ltd', NULL, 'CUS-5'),
      ('mine-4', 'tenant-a', 'user-a', 'Mountain Four Ltd', 'mountain four ltd', NULL, 'CUS-6'),
      ('mine-5', 'tenant-a', 'user-a', 'Mountain Five Ltd', 'mountain five ltd', NULL, 'CUS-7'),
      ('other-owner', 'tenant-a', 'user-b', 'Mountain Other Ltd', 'mountain other ltd', NULL, 'CUS-2'),
      ('other-tenant', 'tenant-b', 'user-a', 'Mountain Secret Ltd', 'mountain secret ltd', NULL, 'CUS-3');`);
    const principal: Principal = {
      tenantId: 'tenant-a',
      organizationId: 'entity-a',
      userId: 'user-a',
      zitadelUserId: 'subject',
      idpOrgId: 'idp',
      orgKind: 'staff',
      partyId: null,
      departmentId: null,
      roles: ['sales'],
      status: 'active',
      grants: new Map([['customer.read', 'all']]),
    };
    const execute = (where: SQL) => {
      const query = new PgDialect().sqlToQuery(where);
      const params: (string | number | null)[] = [];
      const text = query.sql.replace(/\$(\d+)/g, (_match, index: string) => {
        params.push(query.params[Number(index) - 1] as string | number | null);
        return '?';
      });
      return sqlite
        .prepare('SELECT * FROM app.customers WHERE ' + text.replaceAll(' ILIKE ', ' LIKE '))
        .all(...params);
    };
    const db = {
      select: (count?: unknown) => ({
        from: (table: unknown) => {
          // The list's primary-phone read (R6A) joins the contacts to their phones; these customers have none.
          if (table !== customers)
            return { innerJoin: () => ({ where: () => Promise.resolve([]) }) };
          return {
            where: (where: SQL) => {
              const rows = execute(where);
              if (count) return Promise.resolve([{ n: rows.length }]);
              return {
                orderBy: () => ({
                  limit: (limit: number) => ({
                    offset: (offset: number) =>
                      Promise.resolve(
                        rows.slice(offset, offset + limit).map((row) => ({
                          ...row,
                          legalName: row['legal_name'],
                          createdAt: new Date(0),
                          updatedAt: new Date(0),
                        })),
                      ),
                  }),
                }),
              };
            },
          };
        },
      }),
    };
    const service = new CustomersService(
      db as unknown as Db,
      {} as NumberingService,
      {} as AuthzService,
      {
        current: () => ({ scope: { tenantId: principal.tenantId }, principal }),
      } as CustomersCaller,
      {} as AuditService,
    );
    const controller = new CustomersController(service);
    const permission = Reflect.getMetadata(CAN_KEY, controller.list) as 'customer.read';
    expect(permission).toBe('customer.read');
    expect(can(principal, permission).allowed).toBe(true);
    const result = await controller.list({ q: 'Mountain', limit: '20' });
    expect(result.total).toBe(6);
    expect(result.items.map((c) => c.id)).toEqual(
      expect.arrayContaining(['mine', 'mine-5', 'other-owner']),
    );
    expect(result.items.map((c) => c.id)).not.toContain('other-tenant');
    expect((await controller.list({ q: 'Zz', limit: '20' })).items).toEqual([]);
    principal.grants = new Map([['customer.read', 'own']]);
    const own = await controller.list({ q: 'Mountain', limit: '1' });
    expect(own.items.map((c) => c.id)).toEqual(['mine']);
    // The total counts only what this caller may read: not other-owner, not the other tenant.
    expect(own.total).toBe(5);
    principal.grants = new Map();
    expect(can(principal, permission)).toEqual({ allowed: false, reason: 'no_permission' });
    expect((await controller.list({ q: 'Mo' })).items).toEqual([]);
  } finally {
    sqlite.close();
  }
});
