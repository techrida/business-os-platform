import { NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it } from 'vitest';

import type { DbTransaction } from '../db/db.module';
import { UserMirror } from './user-mirror';
import type { UsersSyncData } from './users.constants';
import {
  FakeUsersStore,
  FakeZitadel,
  STAFF_ORG,
  STAFF_ZORG,
  TENANT,
  fakeDb,
  fakeQueue,
  zUser,
} from './users.fakes';

let store: FakeUsersStore;
let zitadel: FakeZitadel;
let queue: ReturnType<typeof fakeQueue>;
let db: ReturnType<typeof fakeDb>;
let mirror: UserMirror;
const scope = { tenantId: TENANT, organizationId: STAFF_ORG };
const tx = {} as DbTransaction;

beforeEach(() => {
  store = new FakeUsersStore();
  zitadel = new FakeZitadel();
  queue = fakeQueue();
  db = fakeDb();
  mirror = new UserMirror(db, store, zitadel.asClient(), queue as unknown as Queue<UsersSyncData>);
});

describe('UserMirror.syncUser', () => {
  it('inserts the user and mirrors grants, bumping authz once', async () => {
    zitadel.users.set('z1', zUser('z1'));
    zitadel.grants.set('z1', ['finance', 'accountant']);

    expect(await mirror.syncUser('z1')).toBe(true);
    const row = store.users[0];
    expect(row).toMatchObject({ zitadelUserId: 'z1', email: 'z1@techrida.test', status: 'active' });
    expect(await store.rolesOf(db, row!.id)).toEqual(['accountant', 'finance']);
    expect(store.authzBumps).toBe(1);
    expect(db.txCount).toBe(1);

    // A second sync with nothing new changes nothing and does not bump authz again.
    expect(await mirror.syncUser('z1')).toBe(false);
    expect(store.authzBumps).toBe(1);
  });

  it('updates name and status, and leaves a user ZITADEL does not return unchanged', async () => {
    zitadel.users.set('z1', zUser('z1'));
    await mirror.syncUser('z1');
    zitadel.users.set('z1', zUser('z1', { displayName: 'Renamed', status: 'inactive' }));
    expect(await mirror.syncUser('z1')).toBe(true);
    expect(store.users[0]).toMatchObject({ displayName: 'Renamed', status: 'inactive' });

    zitadel.users.set('z1', zUser('z1'));
    await mirror.syncUser('z1');
    // Not returned can mean "not visible to the provisioner" (another org): never deactivate on it.
    zitadel.users.delete('z1');
    expect(await mirror.syncUser('z1')).toBe(false);
    expect(store.users[0]?.status).toBe('active');
  });

  it('skips a user whose org has no app.organizations row', async () => {
    zitadel.users.set('z9', zUser('z9', { orgId: 'z-unknown' }));
    expect(await mirror.syncUser('z9')).toBe(false);
    expect(store.users).toHaveLength(0);
    expect(db.txCount).toBe(0);
  });
});

describe('UserMirror.reconcile', () => {
  it('upserts every listed user across pages and deactivates the missing ones', async () => {
    // Two local users: one still in ZITADEL (renamed there), one gone.
    zitadel.users.set('keep', zUser('keep'));
    zitadel.users.set('gone', zUser('gone'));
    await mirror.syncUser('keep');
    await mirror.syncUser('gone');
    zitadel.users.delete('gone');
    zitadel.users.set('keep', zUser('keep', { displayName: 'Keep Renamed' }));
    // Three more new users, so the pass needs two pages of two.
    for (const id of ['a', 'b', 'c']) zitadel.users.set(id, zUser(id));
    zitadel.grants.set('a', ['sales']);

    const result = await mirror.reconcile();

    expect(result).toEqual({ scanned: 4, changed: 5 }); // keep renamed, a, b, c inserted, gone deactivated
    const byZ = (z: string) => store.users.find((u) => u.zitadelUserId === z);
    expect(byZ('keep')?.displayName).toBe('Keep Renamed');
    expect(byZ('gone')?.status).toBe('inactive');
    expect(byZ('c')?.status).toBe('active');
    expect(await mirror.userIdsWithRole(scope, 'sales')).toEqual([byZ('a')?.id]);
    // The pass finished, so the cursor is back at the start for the next run.
    expect(store.cursors.get(`users.reconcile:${STAFF_ZORG}`)).toBe('0');

    expect(await mirror.reconcile()).toEqual({ scanned: 4, changed: 0 });
  });

  it('deactivates nobody when the listing fails or resumes mid-org', async () => {
    zitadel.users.set('x', zUser('x'));
    await mirror.syncUser('x');
    zitadel.users.delete('x');

    zitadel.failListFor.add(STAFF_ZORG);
    expect(await mirror.reconcile()).toEqual({ scanned: 0, changed: 0 });
    expect(store.users[0]?.status).toBe('active');

    // A resumed run (cursor saved mid-way) is a partial pass: upsert only.
    zitadel.failListFor.clear();
    zitadel.users.set('y', zUser('y'));
    store.cursors.set(`users.reconcile:${STAFF_ZORG}`, '1');
    await mirror.reconcile();
    expect(store.users.find((u) => u.zitadelUserId === 'x')?.status).toBe('active');
    // ...and the following full pass does deactivate.
    await mirror.reconcile();
    expect(store.users.find((u) => u.zitadelUserId === 'x')?.status).toBe('inactive');
  });

  it('refuses to deactivate an entire org on an empty listing', async () => {
    zitadel.users.set('x', zUser('x'));
    await mirror.syncUser('x');
    zitadel.users.clear();
    expect(await mirror.reconcile()).toEqual({ scanned: 0, changed: 0 });
    expect(store.users[0]?.status).toBe('active');
  });
});

describe('UserMirror as the UserDirectory backend', () => {
  it('resolve() JIT-inserts an active row once and enqueues users.sync', async () => {
    const i = { zitadelUserId: 'jit', tenantId: TENANT, organizationId: STAFF_ORG };
    const first = await mirror.resolve(i);
    expect(first).toMatchObject({ status: 'active', departmentId: null });
    expect(queue.added).toEqual([{ name: 'users.sync', data: { zitadelUserId: 'jit' } }]);
    expect(db.txCount).toBe(1);

    expect(await mirror.resolve(i)).toEqual(first);
    expect(store.users).toHaveLength(1);
    expect(queue.added).toHaveLength(1);
  });

  it('setRoles writes ZITADEL first, then the mirror, and 404s outside the scope', async () => {
    zitadel.users.set('z1', zUser('z1'));
    await mirror.syncUser('z1');
    const id = store.users[0]!.id;

    await mirror.setRoles(tx, id, ['finance']);
    expect(zitadel.setGrantsCalls).toEqual([
      { userId: 'z1', orgId: STAFF_ZORG, roles: ['finance'] },
    ]);
    expect(await store.rolesOf(db, id)).toEqual(['finance']);
    expect(await mirror.userIdsWithRole(scope, 'finance')).toEqual([id]);

    store.scope = { tenantId: TENANT, organizationId: '00000000-0000-4000-8000-0000000000bb' };
    await expect(mirror.setRoles(tx, id, [])).rejects.toBeInstanceOf(NotFoundException);
  });

  it('invite creates the ZITADEL user, grants, and an invited mirror row', async () => {
    const { userId } = await mirror.invite(tx, {
      email: 'new@techrida.test',
      givenName: 'New',
      familyName: 'Person',
      roles: ['accountant'],
    });
    expect(store.users.find((u) => u.id === userId)).toMatchObject({
      zitadelUserId: 'z-new',
      status: 'invited',
      displayName: 'New Person',
    });
    expect(await store.rolesOf(db, userId)).toEqual(['accountant']);
    expect(zitadel.setGrantsCalls[0]).toMatchObject({ userId: 'z-new', roles: ['accountant'] });
  });
});

describe('UserMirror.resolve on an accepted invite', () => {
  it('turns an invited row active on the first verified request and asks for a sync', async () => {
    const { userId } = await mirror.invite(tx, {
      email: 'inv@techrida.test',
      givenName: 'In',
      familyName: 'Vited',
      roles: [],
    });
    const resolved = await mirror.resolve({
      zitadelUserId: 'z-new',
      tenantId: TENANT,
      organizationId: STAFF_ORG,
    });
    expect(resolved).toEqual({ userId, status: 'active', departmentId: null });
    expect(store.users.find((u) => u.id === userId)?.status).toBe('active');
    expect(queue.added).toEqual([{ name: 'users.sync', data: { zitadelUserId: 'z-new' } }]);
  });
});
