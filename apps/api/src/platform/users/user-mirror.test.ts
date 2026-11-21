import { ACCOUNT_LOCKOUT } from '@bos/contracts';
import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service';
import type { DbTransaction } from '../db/db.module';
import { systemActor } from '../db/tx';
import { UserLocks } from './user-locks';
import { UserMirror, UserSyncContendedError } from './user-mirror';
import { lockoutPinnedCursor, type UsersSyncData } from './users.constants';
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

  it('bumps authz when a status change disables or re-enables a user, so the per-request user cache drops it at once (U20a2-Q10)', async () => {
    zitadel.users.set('z1', zUser('z1'));
    await mirror.syncUser('z1');
    const base = store.authzBumps;

    zitadel.users.set('z1', zUser('z1', { status: 'inactive' }));
    await mirror.syncUser('z1');
    expect(store.authzBumps).toBe(base + 1);

    // A rename alone does not bump: only a status change reaches request authorisation.
    zitadel.users.set('z1', zUser('z1', { status: 'inactive', displayName: 'Renamed' }));
    await mirror.syncUser('z1');
    expect(store.authzBumps).toBe(base + 1);

    zitadel.users.set('z1', zUser('z1', { status: 'active', displayName: 'Renamed' }));
    await mirror.syncUser('z1');
    expect(store.authzBumps).toBe(base + 2);
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

  it('bumps authz once for each user it deactivates (U20a2-Q10)', async () => {
    zitadel.users.set('live', zUser('live'));
    await unlistedLocals(['off']);
    const before = store.authzBumps;
    await mirror.reconcile();
    expect(statusOf('off')).toBe('inactive');
    expect(store.authzBumps).toBeGreaterThan(before);
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

  it('setRoles calls ZITADEL outside any tx, then writes the mirror, and 404s outside the scope', async () => {
    zitadel.users.set('z1', zUser('z1'));
    await mirror.syncUser('z1');
    const id = store.users[0]!.id;
    const openDuringZitadel: number[] = [];
    const realSetGrants = zitadel.setGrants.bind(zitadel);
    vi.spyOn(zitadel, 'setGrants').mockImplementation((...args) => {
      openDuringZitadel.push(db.open);
      return realSetGrants(...args);
    });

    await mirror.setRoles(scope, systemActor('test'), id, ['finance']);
    expect(openDuringZitadel).toEqual([0]);
    expect(zitadel.setGrantsCalls).toEqual([
      { userId: 'z1', orgId: STAFF_ZORG, roles: ['finance'] },
    ]);
    expect(await store.rolesOf(db, TENANT, id)).toEqual(['finance']);
    expect(await mirror.userIdsWithRole(scope, 'finance')).toEqual([id]);

    // Users are tenant-scoped, so only another tenant is "outside the scope".
    const otherScope = {
      tenantId: '00000000-0000-4000-8000-0000000000bb',
      organizationId: STAFF_ORG,
    };
    await expect(mirror.setRoles(otherScope, systemActor('test'), id, [])).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('setRoles compensates ZITADEL grants when the row changes or the DB write fails', async () => {
    zitadel.users.set('z1', zUser('z1'));
    zitadel.grants.set('z1', ['accountant']);
    await mirror.syncUser('z1');
    const id = store.users[0]!.id;

    // Concurrent edit changes the user row while ZITADEL is being called.
    const realSetGrants = zitadel.setGrants.bind(zitadel);
    vi.spyOn(zitadel, 'setGrants').mockImplementationOnce(async (...args) => {
      await realSetGrants(...args);
      const row = store.users[0]!;
      await store.updateUser(tx, id, {
        email: row.email,
        displayName: 'Changed Meanwhile',
        status: row.status,
      });
    });

    const conflict = await mirror
      .setRoles(scope, systemActor('test'), id, ['finance'])
      .catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ConflictException);
    expect((conflict as ConflictException).getResponse()).toMatchObject({ code: 'conflict' });
    expect(zitadel.setGrantsCalls).toEqual([
      { userId: 'z1', orgId: STAFF_ZORG, roles: ['finance'] },
      { userId: 'z1', orgId: STAFF_ZORG, roles: ['accountant'] },
    ]);
    expect(await store.rolesOf(db, TENANT, id)).toEqual(['accountant']);
  });

  it('invite calls ZITADEL outside any tx, creates the user, grants, and an invited mirror row', async () => {
    const openDuringZitadel: number[] = [];
    const realCreate = zitadel.createHuman.bind(zitadel);
    const realGrants = zitadel.setGrants.bind(zitadel);
    const realInvite = zitadel.sendInviteCode.bind(zitadel);
    vi.spyOn(zitadel, 'createHuman').mockImplementation((...args) => {
      openDuringZitadel.push(db.open);
      return realCreate(...args);
    });
    vi.spyOn(zitadel, 'setGrants').mockImplementation((...args) => {
      openDuringZitadel.push(db.open);
      return realGrants(...args);
    });
    vi.spyOn(zitadel, 'sendInviteCode').mockImplementation((...args) => {
      openDuringZitadel.push(db.open);
      return realInvite(...args);
    });

    const { userId } = await mirror.invite(scope, systemActor('test'), {
      email: 'new@techrida.test',
      givenName: 'New',
      familyName: 'Person',
      roles: ['accountant'],
    });
    expect(openDuringZitadel).toEqual([0, 0, 0]);
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

  it('invite takes back the ZITADEL user and grants if the mirror write fails', async () => {
    vi.spyOn(store, 'insertUser').mockRejectedValueOnce(new Error('db write failed'));

    await expect(
      mirror.invite(scope, systemActor('test'), {
        email: 'fail@techrida.test',
        givenName: 'Fail',
        familyName: 'Write',
        roles: ['accountant'],
      }),
    ).rejects.toThrow('db write failed');

    expect(zitadel.setGrantsCalls).toEqual([
      { userId: 'z-new', orgId: STAFF_ZORG, roles: ['accountant'] },
      { userId: 'z-new', orgId: STAFF_ZORG, roles: [] },
    ]);
    expect(zitadel.deletedUsers).toEqual(['z-new']);
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
    await expect(
      mirror.setRoles(scope, systemActor('test'), portal.id, ['finance']),
    ).rejects.toBeInstanceOf(NotFoundException);
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
    const { userId } = await mirror.invite(scope, systemActor('test'), {
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

describe('UserMirror status changes are re-read behind the row lock (F1-Q5)', () => {
  /** getUser answers `stale` once (the read before the row lock), then whatever ZITADEL now holds. */
  const staleOnce = (stale: ReturnType<typeof zUser>) => {
    const real = zitadel.getUser.bind(zitadel);
    let served = false;
    vi.spyOn(zitadel, 'getUser').mockImplementation((id: string) => {
      if (served) return real(id);
      served = true;
      return Promise.resolve(stale);
    });
  };

  beforeEach(async () => {
    zitadel.users.set('z1', zUser('z1'));
    await mirror.syncUser('z1');
  });

  it('does not write back an active state read before an admin deactivated the user (old code: active again)', async () => {
    // The admin's action: ZITADEL and the mirror both say inactive now.
    zitadel.users.set('z1', zUser('z1', { status: 'inactive' }));
    store.users[0]!.status = 'inactive';
    staleOnce(zUser('z1'));

    await mirror.syncUser('z1');

    expect(store.users[0]?.status).toBe('inactive');
  });

  it('does not write back an inactive state read before an admin reactivated the user', async () => {
    store.users[0]!.status = 'active';
    staleOnce(zUser('z1', { status: 'inactive' }));

    await mirror.syncUser('z1');

    expect(store.users[0]?.status).toBe('active');
  });

  it('leaves a change that would let someone in for the next pass when the re-read fails', async () => {
    store.users[0]!.status = 'inactive';
    let calls = 0;
    vi.spyOn(zitadel, 'getUser').mockImplementation(() => {
      calls += 1;
      return calls === 1 ? Promise.resolve(zUser('z1')) : Promise.reject(new Error('ZITADEL 503'));
    });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await mirror.syncUser('z1');

    expect(store.users[0]?.status).toBe('inactive');
  });

  it('still applies a change that takes access away when the re-read fails', async () => {
    let calls = 0;
    vi.spyOn(zitadel, 'getUser').mockImplementation(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(zUser('z1', { status: 'inactive' }))
        : Promise.reject(new Error('ZITADEL 503'));
    });

    await mirror.syncUser('z1');

    expect(store.users[0]?.status).toBe('inactive');
  });
});

describe('UserMirror mirrors ZITADEL locks as a timed lock (F1-Q4)', () => {
  // A lock ZITADEL set a minute ago, after the lockout policy was pinned an hour ago: a failed-sign-in lock.
  const locked = (over: Partial<ReturnType<typeof zUser>> = {}) =>
    zUser('z1', {
      status: 'inactive',
      locked: true,
      changedAt: new Date(Date.now() - 60_000),
      ...over,
    });

  beforeEach(async () => {
    store.cursors.set(
      lockoutPinnedCursor(STAFF_ZORG),
      new Date(Date.now() - 3_600_000).toISOString(),
    );
    zitadel.users.set('z1', zUser('z1'));
    await mirror.syncUser('z1');
  });

  it('turns a lock ZITADEL set after failed sign-ins into a lock that ends 15 minutes after ZITADEL locked them', async () => {
    const lockedAt = new Date(Date.now() - 4 * 60_000);
    zitadel.users.set('z1', locked({ changedAt: lockedAt }));

    expect(await mirror.syncUser('z1')).toBe(true);

    expect(store.users[0]).toMatchObject({
      status: 'inactive',
      lockReason: 'failed_sign_ins',
      lockedUntil: new Date(
        lockedAt.getTime() + ACCOUNT_LOCKOUT.lockMinutes * 60_000,
      ).toISOString(),
    });
  });

  it('treats a lock without a change date as an admin lock, which never ends by itself (P2-1)', async () => {
    zitadel.users.set('z1', locked({ changedAt: null }));

    await mirror.syncUser('z1');

    expect(store.users[0]).toMatchObject({ lockReason: 'admin', lockedUntil: null });
  });

  it('treats a lock from before the lockout policy was pinned as an admin lock (console lock, P2-1)', async () => {
    zitadel.users.set('z1', locked({ changedAt: new Date(Date.now() - 2 * 3_600_000) }));

    await mirror.syncUser('z1');

    expect(store.users[0]).toMatchObject({ lockReason: 'admin', lockedUntil: null });
  });

  it('treats a lock older than one window as an admin lock even after the pin (P2-1)', async () => {
    zitadel.users.set(
      'z1',
      locked({ changedAt: new Date(Date.now() - (ACCOUNT_LOCKOUT.lockMinutes + 1) * 60_000) }),
    );

    await mirror.syncUser('z1');

    expect(store.users[0]).toMatchObject({ lockReason: 'admin', lockedUntil: null });
  });

  it('treats every lock as an admin lock while the lockout policy was never pinned (P2-1)', async () => {
    store.cursors.delete(lockoutPinnedCursor(STAFF_ZORG));
    zitadel.users.set('z1', locked());

    await mirror.syncUser('z1');

    expect(store.users[0]).toMatchObject({ lockReason: 'admin', lockedUntil: null });
  });

  it('keeps a console-locked user locked through reconcile and the lock-expiry job (P2-1)', async () => {
    // Locked in the console two hours ago, before this deployment pinned the policy.
    zitadel.users.set('z1', locked({ changedAt: new Date(Date.now() - 2 * 3_600_000) }));
    const unlockUser = vi.fn(() => Promise.resolve());
    const client = Object.assign(zitadel, { unlockUser }).asClient();
    const audit = { record: vi.fn(() => Promise.resolve()) } as unknown as AuditService;
    const expiry = new UserLocks(db, store, client, audit);

    await mirror.reconcile();
    const result = await expiry.expire(new Date(Date.now() + 2 * 3_600_000));

    expect(result).toEqual({ unlocked: 0, cleared: 0, postponed: 0 });
    expect(unlockUser).not.toHaveBeenCalled();
    expect(store.users[0]).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
      lockedUntil: null,
    });
  });

  it('keeps an admin lock as it is while ZITADEL still holds the user locked', async () => {
    zitadel.users.set('z1', locked());
    Object.assign(store.users[0]!, { status: 'inactive', lockReason: 'admin', lockedUntil: null });
    const writes = store.updates.length;

    expect(await mirror.syncUser('z1')).toBe(false);

    expect(store.updates.length).toBe(writes);
    expect(store.users[0]).toMatchObject({ lockReason: 'admin', lockedUntil: null });
  });

  it('clears the lock when ZITADEL lets the user in again (unlocked in the console)', async () => {
    zitadel.users.set('z1', locked());
    await mirror.syncUser('z1');
    zitadel.users.set('z1', zUser('z1'));

    await mirror.syncUser('z1');

    expect(store.users[0]).toMatchObject({ status: 'active', lockReason: null, lockedUntil: null });
  });

  it('clears the lock but keeps the person out when ZITADEL deactivates a locked user', async () => {
    zitadel.users.set('z1', locked());
    await mirror.syncUser('z1');
    zitadel.users.set('z1', zUser('z1', { status: 'inactive' }));

    expect(await mirror.syncUser('z1')).toBe(true);

    expect(store.users[0]).toMatchObject({ status: 'inactive', lockReason: null });
  });

  it('does not write a lock read before an admin unlocked the user', async () => {
    // The admin's unlock: ZITADEL and the mirror both say active now; the sync read the user while still locked.
    let calls = 0;
    vi.spyOn(zitadel, 'getUser').mockImplementation(() => {
      calls += 1;
      return Promise.resolve(calls === 1 ? locked() : zUser('z1'));
    });

    await mirror.syncUser('z1');

    expect(store.users[0]?.status).toBe('active');
    expect(store.users[0]?.lockReason ?? null).toBeNull();
  });

  it('keeps the stored lock when the re-read of a lock-only change fails', async () => {
    zitadel.users.set('z1', locked());
    await mirror.syncUser('z1');
    const until = store.users[0]?.lockedUntil;
    let calls = 0;
    vi.spyOn(zitadel, 'getUser').mockImplementation(() => {
      calls += 1;
      return calls === 1
        ? Promise.resolve(zUser('z1', { status: 'inactive' }))
        : Promise.reject(new Error('ZITADEL 503'));
    });

    await mirror.syncUser('z1');

    expect(store.users[0]).toMatchObject({
      status: 'inactive',
      lockReason: 'failed_sign_ins',
      lockedUntil: until,
    });
  });
});

describe('UserMirror reads ZITADEL with no transaction open and writes only a row nobody changed meanwhile', () => {
  const adminLock = () => ({ reason: 'admin' as const, lockedAt: new Date(), until: null });

  beforeEach(async () => {
    zitadel.users.set('z1', zUser('z1'));
    await mirror.syncUser('z1');
    store.users[0]!.status = 'invited';
  });

  it('re-reads a status change outside any transaction', async () => {
    const openAt: number[] = [];
    const real = zitadel.getUser.bind(zitadel);
    vi.spyOn(zitadel, 'getUser').mockImplementation((id: string) => {
      openAt.push(db.open);
      return real(id);
    });

    expect(await mirror.syncUser('z1')).toBe(true);

    expect(openAt).toEqual([0, 0]);
    expect(store.users[0]?.status).toBe('active');
  });

  it('does not write an accepted invite over an admin lock that committed during the re-read (old code: active, lock gone)', async () => {
    const real = zitadel.getUser.bind(zitadel);
    let calls = 0;
    vi.spyOn(zitadel, 'getUser').mockImplementation(async (id: string) => {
      calls += 1;
      if (calls !== 2) return real(id);
      // ZITADEL answered "active", then the admin's lock landed: the row first, ZITADEL just before commit.
      const answer = { ...(await real(id))! };
      const row = store.users[0]!;
      await store.updateUser(tx, row.id, {
        email: row.email,
        displayName: row.displayName,
        status: 'inactive',
        lock: adminLock(),
      });
      zitadel.users.set('z1', zUser('z1', { status: 'inactive', locked: true }));
      return answer;
    });

    await mirror.syncUser('z1');

    expect(store.users[0]).toMatchObject({ status: 'inactive', lockReason: 'admin' });
    expect(calls).toBe(3);
  });

  it('gives up after three changed reads with UserSyncContendedError, so the sync job is retried (old code: false, as for no change)', async () => {
    const real = zitadel.getUser.bind(zitadel);
    let calls = 0;
    vi.spyOn(zitadel, 'getUser').mockImplementation(async (id: string) => {
      calls += 1;
      const answer = await real(id);
      if (calls > 1) {
        const row = store.users[0]!;
        await store.updateUser(tx, row.id, {
          email: row.email,
          displayName: `Renamed ${calls}`,
          status: row.status,
        });
      }
      return answer;
    });

    const error = await mirror.syncUser('z1').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UserSyncContendedError);
    expect(error).toMatchObject({ zitadelUserId: 'z1' });
    expect(calls).toBe(4);
    expect(store.users[0]).toMatchObject({ status: 'invited', displayName: 'Renamed 4' });
  });

  it('a reconcile pass logs a contended user and goes on: the others are synced and a missing one is still deactivated', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    zitadel.users.set('gone', zUser('gone'));
    await mirror.syncUser('gone');
    zitadel.users.set('gone', zUser('gone', { status: 'inactive' }));
    zitadel.hiddenFromList.add('gone');
    zitadel.users.set('z1', zUser('z1', { displayName: 'Renamed in ZITADEL' }));
    zitadel.users.set('new', zUser('new'));
    // Every locked read of z1 finds a version other than the one read before it: someone writes it each time.
    const realFind = store.findByZitadelId.bind(store);
    vi.spyOn(store, 'findByZitadelId').mockImplementation(
      async (q: Parameters<typeof realFind>[0], z: string, lock?: boolean) => {
        const row = store.users.find((u) => u.zitadelUserId === z);
        if (lock === true && z === 'z1' && row) {
          await store.updateUser(tx, row.id, {
            email: row.email,
            displayName: row.displayName,
            status: row.status,
          });
        }
        return realFind(q, z);
      },
    );

    const result = await mirror.reconcile();

    const byZ = (z: string) => store.users.find((u) => u.zitadelUserId === z);
    expect(byZ('z1')?.displayName).not.toBe('Renamed in ZITADEL');
    expect(byZ('z1')?.status).toBe('invited');
    expect(byZ('new')?.status).toBe('active');
    expect(byZ('gone')?.status).toBe('inactive');
    expect(result).toEqual({ scanned: 2, changed: 2 }); // new inserted, gone deactivated
    expect(store.cursors.get(`users.reconcile:${STAFF_ZORG}`)).toBe('0');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('z1 kept changing'));
  });
});
