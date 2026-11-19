import { Logger, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DbTransaction } from '../db/db.module';
import { UserMirror } from './user-mirror';
import type { UsersSyncData } from './users.constants';
import {
  CUST_IDP,
  CUST_ZORG,
  FakeUsersStore,
  FakeZitadel,
  STAFF_IDP,
  STAFF_ORG,
  STAFF_ZORG,
  TENANT,
  fakeDb,
  fakeQueue,
  zUser,
} from './users.fakes';
import { statusFromState } from './zitadel-admin.client';

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
    expect(await store.rolesOf(db, TENANT, row!.id)).toEqual(['accountant', 'finance']);
    expect(store.authzBumps).toBe(1);
    expect(db.txCount).toBe(1);
    // A staff user created by sync gets the bootstrap membership (ADR 0027 section 3).
    expect(await store.membershipsOf(db, TENANT, row!.id)).toEqual([
      { organizationId: STAFF_ORG, isDefault: true, roleKeys: null, departmentId: null },
    ]);

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

  it('skips a user whose org has no app.idp_orgs row', async () => {
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
    // Gone from the list, and ZITADEL itself says inactive when asked about it directly.
    zitadel.users.set('gone', zUser('gone', { status: 'inactive' }));
    zitadel.hiddenFromList.add('gone');
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
    zitadel.users.set('x', zUser('x', { status: 'inactive' }));
    zitadel.hiddenFromList.add('x');

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
    // ZITADEL says inactive when asked directly, so only the empty-listing guard keeps x active.
    zitadel.users.set('x', zUser('x', { status: 'inactive' }));
    zitadel.hiddenFromList.add('x');
    expect(await mirror.reconcile()).toEqual({ scanned: 0, changed: 0 });
    expect(store.users[0]?.status).toBe('active');
  });
});

/** Seeds local rows for `ids` (active), then makes ZITADEL report each as `state` yet omit it from the list. */
async function unlistedLocals(ids: string[], state: ZitadelUserState = 'inactive') {
  for (const id of ids) {
    zitadel.users.set(id, zUser(id));
    await mirror.syncUser(id);
    zitadel.users.set(id, zUser(id, { status: state }));
    zitadel.hiddenFromList.add(id);
  }
}
type ZitadelUserState = ReturnType<typeof zUser>['status'];

const statusOf = (z: string) => store.users.find((u) => u.zitadelUserId === z)?.status;

describe('UserMirror.reconcile paging safeguards (R8)', () => {
  beforeEach(async () => {
    // One local user ZITADEL calls inactive but never lists: only a paging abort keeps it active.
    await unlistedLocals(['gone']);
    for (const id of ['a', 'b', 'c', 'd', 'e']) zitadel.users.set(id, zUser(id));
    zitadel.getUserCalls = []; // the seeding above called getUser; only the pass's calls count
  });

  it('aborts with no deactivations when ZITADEL ignores the offset', async () => {
    zitadel.ignoreOffset = true;
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await mirror.reconcile();
    expect(statusOf('gone')).toBe('active');
    expect(zitadel.getUserCalls).not.toContain('gone');
    expect(errors).toHaveBeenCalled();
    // The next run starts the org over instead of resuming from a cursor the server ignored.
    expect(store.cursors.get(`users.reconcile:${STAFF_ZORG}`)).toBe('0');
    errors.mockRestore();
  });

  it('aborts when the collected users do not match totalResult', async () => {
    zitadel.totalOverride = 12; // ZITADEL says 12 users, the walk collected 5
    await mirror.reconcile();
    expect(statusOf('gone')).toBe('active');
    expect(zitadel.getUserCalls).not.toContain('gone');
  });

  it('trusts the walk when totalResult is absent, then still confirms each candidate', async () => {
    zitadel.omitTotal = true;
    await mirror.reconcile();
    expect(zitadel.getUserCalls).toContain('gone');
    expect(statusOf('gone')).toBe('inactive');
  });

  it('aborts with an error at the page cap and deactivates nobody', async () => {
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    await mirror.reconcile({ maxPages: 2 }); // 5 users at 2 per page need 3 pages
    expect(statusOf('gone')).toBe('active');
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('page cap'));
    errors.mockRestore();
  });
});

describe('UserMirror.reconcile deactivation safeguards (R8, R18)', () => {
  const HIDDEN = ['h1', 'h2', 'h3', 'h4', 'h5'];

  it('deactivates at most the per-pass cap, and stops there', async () => {
    zitadel.users.set('live', zUser('live'));
    await unlistedLocals(HIDDEN);
    const warns = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await mirror.reconcile({ maxDeactivations: 2 });

    expect(HIDDEN.filter((z) => statusOf(z) === 'inactive')).toHaveLength(2);
    expect(warns).toHaveBeenCalledWith(expect.stringContaining('cap'));
    warns.mockRestore();
    // The next pass picks up the rest.
    await mirror.reconcile({ maxDeactivations: 2 });
    expect(HIDDEN.filter((z) => statusOf(z) === 'inactive')).toHaveLength(4);
  });

  it('deactivates only on a definite inactive answer from getUser', async () => {
    zitadel.users.set('live', zUser('live'));
    await unlistedLocals(['off']);
    await unlistedLocals(['locked']); // a locked ZITADEL user maps to inactive
    await unlistedLocals(['alive'], 'active');
    await unlistedLocals(['odd'], null); // ZITADEL state we do not recognise
    await unlistedLocals(['ghost']);
    zitadel.users.delete('ghost'); // not found: maybe just invisible to the provisioner token
    const warns = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await mirror.reconcile();

    expect(statusOf('off')).toBe('inactive');
    expect(statusOf('locked')).toBe('inactive');
    expect(statusOf('alive')).toBe('active');
    expect(statusOf('odd')).toBe('active');
    expect(statusOf('ghost')).toBe('active');
    expect(warns).toHaveBeenCalledWith(expect.stringContaining('odd'));
    warns.mockRestore();
  });

  it('never deactivates a user created or invited after the pass started', async () => {
    for (const id of ['live', 'live2', 'live3']) zitadel.users.set(id, zUser(id));
    // While the pass walks page 2, an admin invites one user and another appears with a creation
    // date after the pass start. Their local rows exist (invite/JIT) but the list never showed them.
    zitadel.onListUsers = (call) => {
      if (call !== 2) return;
      zitadel.users.set('late-invited', zUser('late-invited', { status: 'invited' }));
      zitadel.users.set(
        'late-odd',
        zUser('late-odd', { status: 'inactive', createdAt: new Date() }),
      );
      for (const id of ['late-invited', 'late-odd']) {
        zitadel.hiddenFromList.add(id);
        void store.insertUser(tx, scope, {
          zitadelUserId: id,
          idpOrgId: STAFF_IDP,
          email: null,
          displayName: null,
          status: 'active',
        });
      }
    };

    await mirror.reconcile();

    expect(statusOf('late-invited')).toBe('active');
    // Even a contrived inactive answer does not count: the user is newer than the pass.
    expect(statusOf('late-odd')).toBe('active');
  });
});

describe('Strict ZITADEL state mapping (R18)', () => {
  it('maps only explicit states; anything else is unknown (null)', () => {
    expect(statusFromState('USER_STATE_ACTIVE')).toBe('active');
    expect(statusFromState('USER_STATE_INITIAL')).toBe('invited');
    expect(statusFromState('USER_STATE_INACTIVE')).toBe('inactive');
    expect(statusFromState('USER_STATE_LOCKED')).toBe('inactive');
    for (const unknown of ['USER_STATE_UNSPECIFIED', '', 'USER_STATE_DELETED', 'WHATEVER']) {
      expect(statusFromState(unknown)).toBeNull();
    }
  });

  it('leaves an existing user unchanged, and inserts no new one, on an unknown state', async () => {
    zitadel.users.set('known', zUser('known'));
    await mirror.syncUser('known');
    const warns = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    zitadel.users.set('known', zUser('known', { status: null, displayName: 'Renamed' }));
    zitadel.users.set('fresh', zUser('fresh', { status: null }));
    expect(await mirror.syncUser('known')).toBe(false);
    expect(await mirror.syncUser('fresh')).toBe(false);
    await mirror.reconcile();

    expect(store.users.find((u) => u.zitadelUserId === 'known')).toMatchObject({
      status: 'active',
      displayName: 'User known',
    });
    expect(store.users.find((u) => u.zitadelUserId === 'fresh')).toBeUndefined();
    expect(warns).toHaveBeenCalledWith(expect.stringContaining('unknown state'));
    warns.mockRestore();
  });
});

describe('UserMirror as the UserDirectory backend', () => {
  it('resolve() JIT-creates a staff user with one default membership, once, and enqueues users.sync', async () => {
    const i = { zitadelUserId: 'jit', tenantId: TENANT, idpOrgId: STAFF_IDP };
    const first = await mirror.resolve(i);
    expect(first).toEqual({
      userId: store.users[0]?.id,
      status: 'active',
      tenantId: TENANT,
      idpOrgId: STAFF_IDP,
      memberships: [
        { organizationId: STAFF_ORG, isDefault: true, roleKeys: null, departmentId: null },
      ],
    });
    expect(store.users[0]).not.toHaveProperty('organizationId');
    expect(queue.added).toEqual([{ name: 'users.sync', data: { zitadelUserId: 'jit' } }]);
    // The user row and its membership went through one withTx.
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
    expect(await store.rolesOf(db, TENANT, id)).toEqual(['finance']);
    expect(await mirror.userIdsWithRole(scope, 'finance')).toEqual([id]);

    // Users are tenant-scoped, so only another tenant is "outside the scope".
    store.scope = { tenantId: '00000000-0000-4000-8000-0000000000bb', organizationId: STAFF_ORG };
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
    expect(await store.rolesOf(db, TENANT, userId)).toEqual(['accountant']);
    expect(zitadel.setGrantsCalls[0]).toMatchObject({ userId: 'z-new', roles: ['accountant'] });
    // An invited staff user gets the default membership too.
    expect(await store.membershipsOf(db, TENANT, userId)).toEqual([
      { organizationId: STAFF_ORG, isDefault: true, roleKeys: null, departmentId: null },
    ]);
  });
});

describe('Bootstrap rule (ADR 0027 section 3)', () => {
  it('gives a portal user no membership, on JIT and on sync', async () => {
    const jit = await mirror.resolve({
      zitadelUserId: 'p1',
      tenantId: TENANT,
      idpOrgId: CUST_IDP,
    });
    expect(jit).toMatchObject({ idpOrgId: CUST_IDP, memberships: [] });

    zitadel.users.set('p2', zUser('p2', { orgId: CUST_ZORG }));
    expect(await mirror.syncUser('p2')).toBe(true);
    const p2 = store.users.find((u) => u.zitadelUserId === 'p2');
    expect(p2?.idpOrgId).toBe(CUST_IDP);
    expect(store.memberships).toHaveLength(0);
  });

  it('keeps admin paths on staff users: setRoles 404s on a portal user and list omits them', async () => {
    zitadel.users.set('p3', zUser('p3', { orgId: CUST_ZORG }));
    await mirror.syncUser('p3');
    const portal = store.users.find((u) => u.zitadelUserId === 'p3')!;
    await expect(mirror.setRoles(tx, portal.id, ['finance'])).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(zitadel.setGrantsCalls).toEqual([]);
    expect(await mirror.list(scope, { limit: 10 })).toEqual({ rows: [], total: 0 });
  });

  it('does not add a default membership to a staff user who already has one', async () => {
    const first = await mirror.resolve({
      zitadelUserId: 's1',
      tenantId: TENANT,
      idpOrgId: STAFF_IDP,
    });
    zitadel.users.set('s1', zUser('s1'));
    await mirror.syncUser('s1');
    expect(store.memberships.filter((m) => m.userId === first.userId)).toHaveLength(1);
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
      idpOrgId: STAFF_IDP,
    });
    expect(resolved).toEqual({
      userId,
      status: 'active',
      tenantId: TENANT,
      idpOrgId: STAFF_IDP,
      memberships: [
        { organizationId: STAFF_ORG, isDefault: true, roleKeys: null, departmentId: null },
      ],
    });
    expect(store.users.find((u) => u.id === userId)?.status).toBe('active');
    expect(queue.added).toEqual([{ name: 'users.sync', data: { zitadelUserId: 'z-new' } }]);
  });
});
