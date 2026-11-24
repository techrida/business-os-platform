// Integration test for NotifyService: a real postgres:16-alpine started by Testcontainers (needs Docker).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/notify/notify.service.integration.test.ts
//
// Only a real database can show what the outbox pattern promises: a notice commits or rolls back together
// with the business change, and a retried event does not notify twice. UserDirectory and the queue are
// fakes; everything else (migrations, roles, withTx, unique constraints) is the real thing. Setup is copied
// from numbering.service.test.ts: the container starts with a superuser only, so beforeAll creates the
// roles that infra/postgres/init-dbs.sh creates, migrates as bos_owner and then works as bos_app.
import { randomUUID } from 'node:crypto';

import type { RoleKey } from '@bos/contracts';
import { createStaffUser, createTenantWithEntity, notifications } from '@bos/db';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../authz/principal';
import { UserDirectory } from '../authz/user-directory';
import type { CoreConfig } from '../config/config';
import { type Db } from '../db/db.module';
import { type TxScope, systemActor, withTx } from '../db/tx';
import { bindIdentity, bindPrincipal, runWithRequestStore } from '../tenancy/request-context';
import { UserMirror } from '../users/user-mirror';
import { UsersService } from '../users/users.service';
import { SqlUsersStore } from '../users/users.store';
import { SettingsService } from '../settings/settings.service';
import { NotifyService } from './notify.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

/** A directory that knows the seeded users; `roleHolders` is what userIdsWithRole answers. */
class FakeDirectory extends UserDirectory {
  readonly emails = new Map<string, string | null>();
  roleHolders: string[] = [];
  resolve(): never {
    throw new Error('not used');
  }
  userIdsWithRole(_scope: TxScope, _role: RoleKey): Promise<string[]> {
    return Promise.resolve(this.roleHolders);
  }
  emailOf(userId: string): Promise<string | null> {
    return Promise.resolve(this.emails.get(userId) ?? null);
  }
}

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;
let scope: TxScope;
let idpOrgId: string;
let service: NotifyService;
const directory = new FakeDirectory();
// Filled in beforeAll: the fixtures generate the user ids.
const ids = { a: '', b: '', c: '', noEmail: '' };

const email = {
  template: 'approval.pending' as const,
  vars: {
    documentNumber: 'MEMO-2082/83-00001',
    documentType: 'memo',
    requesterName: 'Asha',
    linkPath: '/inbox/abc',
  },
};

function input(userId: string, dedupeKey: string, withEmail = true) {
  return {
    userId,
    title: 'Approval needed',
    body: 'MEMO-2082/83-00001 is waiting for you',
    link: '/inbox/abc',
    dedupeKey,
    ...(withEmail ? { email } : {}),
  };
}

async function countRows(table: 'notifications' | 'outbox', dedupePrefix: string): Promise<number> {
  const { rows } = await appPool.query<{ n: string }>(
    `SELECT count(*) AS n FROM app.${table} WHERE dedupe_key LIKE $1`,
    [`${dedupePrefix}%`],
  );
  return Number(rows[0]?.n);
}

/** Runs `fn` as `userId` inside a request store, the way the tenancy interceptor would bind it. */
function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestStore('corr-12345678', () => {
    bindIdentity({
      ...scope,
      orgKind: 'staff',
      partyId: null,
      idpOrgId,
      userId: `zitadel-${userId}`,
      roles: [],
      departmentId: null,
      tokenExp: 1_900_000_000,
    });
    const p: Principal = {
      userId,
      zitadelUserId: `zitadel-${userId}`,
      ...scope,
      orgKind: 'staff',
      partyId: null,
      idpOrgId,
      roles: [],
      departmentId: null,
      status: 'active',
      grants: new Map(),
    };
    bindPrincipal(p);
    return fn();
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  appPool = new Pool({ connectionString: testDb.appUrl, max: 5 });
  db = drizzle({ client: appPool });

  const tenant = await createTenantWithEntity(appPool);
  scope = { tenantId: tenant.tenantId, organizationId: tenant.organizationId };
  idpOrgId = tenant.idpOrgId;
  for (const name of Object.keys(ids) as (keyof typeof ids)[]) {
    const { userId } = await createStaffUser(appPool, { ...tenant });
    ids[name] = userId;
    directory.emails.set(userId, name === 'noEmail' ? null : `${name}@example.com`);
  }

  // The queue is only touched by nudge(), which has its own unit test.
  service = new NotifyService(
    db,
    { WORKSPACE_PUBLIC_URL: 'https://app.example.com' } as CoreConfig,
    directory,
    {} as Queue,
  );
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await testDb?.drop();
});

describe('NotifyService.notifyUser (the write path)', () => {
  it('leaves no notification and no outbox row when the transaction rolls back', async () => {
    const failed = withTx(db, scope, systemActor('test'), async (tx) => {
      await service.notifyUser(tx, input(ids.a, 'rollback:1'));
      throw new Error('business step failed');
    });
    await expect(failed).rejects.toThrow('business step failed');

    expect(await countRows('notifications', 'rollback:1')).toBe(0);
    expect(await countRows('outbox', 'rollback:1')).toBe(0);
  });

  it('leaves exactly one notification and one outbox row when it commits', async () => {
    await withTx(db, scope, systemActor('test'), (tx) =>
      service.notifyUser(tx, input(ids.a, 'commit:1')),
    );

    expect(await countRows('notifications', 'commit:1')).toBe(1);
    expect(await countRows('outbox', 'commit:1')).toBe(1);

    const { rows } = await appPool.query<{ body_text: string }>(
      `SELECT to_user_id, to_email, template, status, dedupe_key, subject, body_text
         FROM app.outbox WHERE dedupe_key LIKE 'commit:1%'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      to_user_id: ids.a,
      to_email: 'a@example.com',
      template: 'approval.pending',
      status: 'pending',
      dedupe_key: `commit:1:${ids.a}`,
    });
    // The link is built from WORKSPACE_PUBLIC_URL, so the stored body already holds the final address.
    expect(rows[0]?.body_text).toContain('https://app.example.com/inbox/abc');
  });

  it('does not duplicate anything for the same dedupeKey, in one transaction or across two', async () => {
    await withTx(db, scope, systemActor('test'), async (tx) => {
      await service.notifyUser(tx, input(ids.b, 'dedupe:1'));
      await service.notifyUser(tx, input(ids.b, 'dedupe:1'));
    });
    await withTx(db, scope, systemActor('test'), (tx) =>
      service.notifyUser(tx, input(ids.b, 'dedupe:1')),
    );

    expect(await countRows('notifications', 'dedupe:1')).toBe(1);
    expect(await countRows('outbox', 'dedupe:1')).toBe(1);
  });

  it('keeps the notification and writes no outbox row when the user has no email', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await withTx(db, scope, systemActor('test'), (tx) =>
        service.notifyUser(tx, input(ids.noEmail, 'noemail:1')),
      );
      expect(warn).toHaveBeenCalledExactlyOnceWith({
        event: 'notify.email_skipped',
        reason: 'no_email_address',
        template: 'approval.pending',
      });
    } finally {
      warn.mockRestore();
    }

    expect(await countRows('notifications', 'noemail:1')).toBe(1);
    expect(await countRows('outbox', 'noemail:1')).toBe(0);
  });

  it('writes only the notification when no email is requested', async () => {
    await withTx(db, scope, systemActor('test'), (tx) =>
      service.notifyUser(tx, input(ids.a, 'bellonly:1', false)),
    );

    expect(await countRows('notifications', 'bellonly:1')).toBe(1);
    expect(await countRows('outbox', 'bellonly:1')).toBe(0);
  });

  it('rolls the whole transaction back when the email variables break a template rule', async () => {
    const bad = withTx(db, scope, systemActor('test'), (tx) =>
      service.notifyUser(tx, {
        ...input(ids.a, 'badvars:1'),
        email: { template: 'approval.pending', vars: { ...email.vars, apiToken: 'x' } },
      }),
    );
    await expect(bad).rejects.toThrow(/not allowed in an email/);

    expect(await countRows('notifications', 'badvars:1')).toBe(0);
  });

  it('refuses a transaction that was not opened with withTx', async () => {
    await expect(
      db.transaction((tx) => service.notifyUser(tx, input(ids.a, 'bare:1'))),
    ).rejects.toThrow(/withTx/);
  });
});

describe('NotifyService.notifyRole', () => {
  it('fans out to every role holder: three notifications, three outbox rows, one dedupe key each', async () => {
    directory.roleHolders = [ids.a, ids.b, ids.c];
    const { userId: _ignored, ...rest } = input(ids.a, 'role:1');

    await withTx(db, scope, systemActor('test'), (tx) => service.notifyRole(tx, 'founder', rest));

    expect(await countRows('notifications', 'role:1')).toBe(3);
    expect(await countRows('outbox', 'role:1')).toBe(3);
    const { rows } = await appPool.query<{ dedupe_key: string }>(
      `SELECT dedupe_key FROM app.outbox WHERE dedupe_key LIKE 'role:1%' ORDER BY dedupe_key`,
    );
    expect(rows.map((r) => r.dedupe_key).sort()).toEqual(
      [ids.a, ids.b, ids.c].map((id) => `role:1:${id}`).sort(),
    );
  });
});

describe('NotifyService reads the directory through the caller transaction', () => {
  it('finds role holders and their addresses on the transaction, never a second pooled connection', async () => {
    const { userId: holder } = await createStaffUser(appPool, {
      ...scope,
      idpOrgId,
      roleKeys: ['accountant'],
    });
    const guard = poolGuard(db);
    // The real directory chain (UsersService -> UserMirror -> SqlUsersStore) over the watched handle, so a layer
    // that drops the transaction shows up here. The ZITADEL client, queue and audit are never reached.
    const store = new SqlUsersStore(guard.db);
    const users = new UsersService(
      new UserMirror(guard.db, store, {} as never, {} as never),
      store,
      {} as never,
      guard.db,
      {} as never,
    );
    const guarded = new NotifyService(
      guard.db,
      { WORKSPACE_PUBLIC_URL: 'https://app.example.com' } as CoreConfig,
      users,
      {} as Queue,
    );
    const { userId: _ignored, ...rest } = input(ids.a, 'txread:role');

    await withTx(guard.db, scope, systemActor('test'), async (tx) => {
      await guarded.notifyUser(tx, input(ids.a, 'txread:user'));
      await guarded.notifyRole(tx, 'accountant', rest);
    });

    expect(guard.touches).toEqual([]);
    // The reads on the transaction still see the users: each outbox row carries the mirrored address.
    const { rows } = await appPool.query<{ dedupe_key: string; to_email: string | null }>(
      `SELECT o.dedupe_key, o.to_email FROM app.outbox o
         JOIN app.users u ON u.id = o.to_user_id AND u.email = o.to_email
        WHERE o.dedupe_key LIKE 'txread:%' ORDER BY o.dedupe_key`,
    );
    expect(rows.map((r) => r.dedupe_key)).toEqual([
      `txread:role:${holder}`,
      `txread:user:${ids.a}`,
    ]);
  });
});

/**
 * A Db that records every call made on it while a transaction it opened is still open. Such a call takes a second
 * pooled connection while the transaction holds the first, so under load the pool can run dry and stall.
 */
function poolGuard(real: Db): { db: Db; touches: string[] } {
  const touches: string[] = [];
  let open = 0;
  const where = () =>
    (new Error().stack ?? '')
      .split('\n')
      .filter((line) => line.includes('/src/') && !line.includes('.test.'))
      .slice(0, 2)
      .map((line) => line.trim())
      .join(' < ');
  const db = new Proxy(real, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      if (prop === 'transaction') {
        return (fn: (tx: unknown) => Promise<unknown>, config?: unknown) =>
          target.transaction(async (tx) => {
            open += 1;
            try {
              return await fn(tx);
            } finally {
              open -= 1;
            }
          }, config as never);
      }
      return (...args: unknown[]) => {
        if (open > 0) touches.push(`${String(prop)} at ${where()}`);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { db, touches };
}

describe('NotifyService reads and markRead', () => {
  async function seed(userId: string, title: string, createdAt: Date): Promise<string> {
    const id = randomUUID();
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx.insert(notifications).values({
        id,
        ...scope,
        userId,
        title,
        body: 'body',
        link: '/inbox/x',
        dedupeKey: `read:${id}`,
        createdAt,
      }),
    );
    return id;
  }

  async function readAt(id: string): Promise<Date | null> {
    const { rows } = await appPool.query<{ read_at: Date | null }>(
      'SELECT read_at FROM app.notifications WHERE id = $1',
      [id],
    );
    return rows[0]?.read_at ?? null;
  }

  /** A user nobody else wrote to, so a test sees only its own rows. */
  async function newUser(): Promise<string> {
    const { userId } = await createStaffUser(appPool, { ...scope, idpOrgId });
    return userId;
  }

  it('lists only my notifications, newest first, and pages with before', async () => {
    const me = await newUser();
    const mine: string[] = [];
    for (let i = 0; i < 5; i++) {
      mine.push(await seed(me, `mine-${i}`, new Date(Date.UTC(2030, 0, 1, 0, 0, i))));
    }
    await seed(ids.b, 'not-mine', new Date(Date.UTC(2030, 0, 1, 0, 0, 30)));
    const newestFirst = [...mine].reverse();

    const first = await asUser(me, () => service.listMine(2));
    expect(first.map((n) => n.id)).toEqual(newestFirst.slice(0, 2));
    const second = await asUser(me, () => service.listMine(2, first[1]?.id));
    expect(second.map((n) => n.id)).toEqual(newestFirst.slice(2, 4));
    const third = await asUser(me, () => service.listMine(2, second[1]?.id));
    expect(third.map((n) => n.id)).toEqual(newestFirst.slice(4));
    expect([...first, ...second, ...third].map((n) => n.title)).not.toContain('not-mine');
    expect(first[0]).toMatchObject({ readAt: null, link: '/inbox/x' });
  });

  it('gives an empty page, not an error, for a before id that is not mine', async () => {
    const foreign = await seed(ids.b, 'foreign', new Date());
    expect(await asUser(ids.c, () => service.listMine(10, foreign))).toEqual([]);
  });

  it('counts unread, and markRead lowers the count and keeps the first read time', async () => {
    const uid = await newUser();
    const n1 = await seed(uid, 'one', new Date());
    await seed(uid, 'two', new Date());

    expect(await asUser(uid, () => service.unreadCount())).toBe(2);
    await asUser(uid, () => service.markRead(n1));
    expect(await asUser(uid, () => service.unreadCount())).toBe(1);

    const firstRead = await readAt(n1);
    await asUser(uid, () => service.markRead(n1)); // reading again is fine
    expect(firstRead).toBeInstanceOf(Date);
    expect(await readAt(n1)).toEqual(firstRead);
  });

  it("answers 404 and changes nothing for another user's notification, and for an unknown id", async () => {
    const theirs = await seed(ids.b, 'theirs', new Date());

    await expect(asUser(ids.c, () => service.markRead(theirs))).rejects.toMatchObject({
      status: 404,
    });
    await expect(asUser(ids.c, () => service.markRead(randomUUID()))).rejects.toMatchObject({
      status: 404,
    });
    expect(await readAt(theirs)).toBeNull();
  });
});

describe('the company logo in emails (R6Q20)', () => {
  const LOGO = '5c1f3b7e-2d4a-4e8b-9a6c-0f1e2d3c4b5a';
  const bodyOf = async (dedupePrefix: string) =>
    (
      await appPool.query<{ body_html: string; body_text: string }>(
        'SELECT body_html, body_text FROM app.outbox WHERE dedupe_key LIKE $1',
        [`${dedupePrefix}%`],
      )
    ).rows[0];

  it('puts the logo at the top of a staff email and a customer email once the profile has one, and not before', async () => {
    const both = new NotifyService(
      db,
      {
        WORKSPACE_PUBLIC_URL: 'https://app.example.com',
        PORTAL_PUBLIC_URL: 'https://portal.example.com',
      } as CoreConfig,
      directory,
      {} as Queue,
    );
    await withTx(db, scope, systemActor('test'), (tx) =>
      both.notifyUser(tx, input(ids.a, 'logo:none')),
    );
    expect((await bodyOf('logo:none'))?.body_html).not.toContain('<img');

    await withTx(db, scope, systemActor('test'), async (tx) => {
      const settings = new SettingsService(db);
      const current = (await settings.getLocked(tx, 'entity.profile')).value;
      await settings.set(tx, 'entity.profile', {
        ...current,
        displayName: 'Techrida',
        logoDocumentId: LOGO,
      });
    });
    await withTx(db, scope, systemActor('test'), async (tx) => {
      await both.notifyUser(tx, input(ids.a, 'logo:staff'));
      await both.notifyEmail(tx, {
        toEmail: 'customer@example.com',
        template: 'quotation.sent',
        data: { quotationNumber: 'Q-1', customerName: 'Acme', linkPath: '/quotations/abc' },
        dedupeKey: 'logo:customer',
      });
    });

    const staff = await bodyOf('logo:staff');
    expect(staff?.body_html).toContain(
      `<img src="https://app.example.com/brand/logo/${scope.tenantId}/${LOGO}" alt="Techrida"`,
    );
    const customer = await bodyOf('logo:customer');
    expect(customer?.body_html).toContain(
      `src="https://portal.example.com/brand/logo/${scope.tenantId}/${LOGO}"`,
    );
    // The text part stays text: no image reference.
    expect(staff?.body_text).not.toContain('brand/logo');
  });
});
