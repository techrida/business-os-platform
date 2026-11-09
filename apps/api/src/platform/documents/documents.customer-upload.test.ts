// A portal customer uploads to an owner whose policy allows it (P3 U5: payment proof on their own payment).
// Unit level, with the REAL AuthzService.assert (so a missing grant throws exactly as in production) and the
// principal bound in the real request store. Only the database is faked. The hook skips the documents.upload
// grant check for an active customer with a party, acting as itself, and nothing else: every other caller
// and every refusal gets the grant check's own 403, with today's body. Postgres: the integration twin.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  MAX_UPLOAD_BYTES,
  type CreateDocumentBody,
  type Permission,
  type Scope,
} from '@bos/contracts';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import { AuthzService } from '../authz/authz.service';
import type { Principal } from '../authz/can';
import type { RoleCache } from '../authz/role-cache';
import type { Db, DbTransaction } from '../db/tx';
import { bindIdentity, bindPrincipal, runWithRequestStore } from '../tenancy/request-context';
import type { CounterpartyPrincipal, DocumentOwnerPolicy } from './documents.ports';
import { DocumentsService } from './documents.service';
import type { SignedLinks } from './signed-link';
import type { StorageAdapter } from './storage.adapter';

const TENANT = randomUUID();
const ORG = randomUUID();
const USER = randomUUID();
const PARTY = randomUUID();
const OWNER_ID = randomUUID();
const OWNER_TYPE = 'payment';
const SCOPE = { tenantId: TENANT, organizationId: ORG };

const body = (over: Partial<CreateDocumentBody> = {}): CreateDocumentBody => ({
  ownerType: OWNER_TYPE,
  ownerId: OWNER_ID,
  filename: 'proof.pdf',
  declaredMime: 'application/pdf',
  sizeBytes: 1234,
  ...over,
});

function caller(over: Partial<Principal> = {}): Principal {
  return {
    userId: USER,
    zitadelUserId: 'zitadel-sub',
    tenantId: TENANT,
    organizationId: ORG,
    orgKind: 'customer',
    partyId: PARTY,
    idpOrgId: randomUUID(),
    roles: ['customer_user'],
    departmentId: null,
    status: 'active',
    // A customer holds no documents.upload (staffBaseGrants only): the hook is the only way in.
    grants: new Map<Permission, Scope>(),
    ...over,
  };
}

const staff = (grants: [Permission, Scope][] = []): Principal =>
  caller({ orgKind: 'staff', partyId: null, roles: ['sales'], grants: new Map(grants) });

/** Runs `fn` as the request of `p`, as the tenancy interceptor would bind it. */
function asCaller<T>(p: Principal, fn: () => Promise<T>): Promise<T> {
  return runWithRequestStore('corr-1', () => {
    bindIdentity({
      tenantId: p.tenantId,
      organizationId: p.organizationId,
      orgKind: p.orgKind,
      partyId: p.partyId,
      idpOrgId: p.idpOrgId,
      userId: p.zitadelUserId,
      roles: p.roles,
      departmentId: p.departmentId,
      tokenExp: Math.floor(Date.now() / 1000) + 300,
    });
    bindPrincipal(p);
    return fn();
  });
}

/**
 * A transaction that answers readTxContext with a user actor, records inserts, and answers every locked
 * select with `rows` (the document or version a create-version or receive step loads).
 */
function fakeTx(opts: { actorId?: string; rows?: unknown[] } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: () => chain,
    limit: () => chain,
    for: () => Promise.resolve(opts.rows ?? []),
  };
  const tx = {
    execute: vi.fn().mockResolvedValue({
      rows: [
        {
          tenant_id: TENANT,
          organization_id: ORG,
          actor_id: opts.actorId ?? USER,
          actor_kind: 'user',
        },
      ],
    }),
    insert: vi.fn(() => ({
      values: (values: Record<string, unknown>) => {
        inserted.push(values);
        return Promise.resolve();
      },
    })),
    select: vi.fn(() => chain),
    update: vi.fn(() => {
      throw new Error('no update expected in these tests');
    }),
  };
  return { tx: tx as unknown as DbTransaction, inserted };
}

function setup(
  hook: 'allow' | 'refuse' | 'absent',
  over: {
    resource?: DocumentOwnerPolicy['resource'];
    canAttach?: boolean;
    tx?: DbTransaction;
  } = {},
) {
  const authz = new AuthzService({} as Db, {} as RoleCache);
  const db = {
    transaction: (fn: (tx: DbTransaction) => Promise<unknown>) => fn(over.tx ?? fakeTx().tx),
  };
  const service = new DocumentsService(
    db as unknown as Db,
    {} as StorageAdapter,
    {} as SignedLinks,
    { add: vi.fn() } as unknown as Queue,
    authz,
    { record: vi.fn().mockResolvedValue(undefined) },
  );
  const allowsCounterparty = vi.fn(
    (_p: CounterpartyPrincipal, _ownerId: string, _tx: DbTransaction) =>
      Promise.resolve(hook === 'allow'),
  );
  service.registerOwner({
    ownerType: OWNER_TYPE,
    resource:
      over.resource ??
      ((scope: { tenantId: string; organizationId: string }) =>
        Promise.resolve({
          ...scope,
          ownerUserId: USER,
          customerPartyId: PARTY,
          sodUserIds: [],
        })),
    canAttach: () => Promise.resolve(over.canAttach ?? true),
    ...(hook === 'absent' ? {} : { allowsCounterparty }),
  });
  return { service, allowsCounterparty };
}

/** The 403 body as the client sees it, or a marker when the call did not refuse with a 403. */
const forbiddenBody = (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => 'resolved',
    (e: unknown) =>
      e instanceof ForbiddenException
        ? JSON.stringify(e.getResponse())
        : `other: ${e instanceof Error ? e.message : 'not an Error'}`,
  );

describe('DocumentsService.create for a portal customer', () => {
  it('creates the document when the owner policy accepts the customer, and hands it the caller', async () => {
    const { service, allowsCounterparty } = setup('allow');
    const { tx, inserted } = fakeTx();

    const created = await asCaller(caller(), () => service.create(tx, body()));

    expect(created.documentId).toEqual(expect.any(String));
    expect(inserted).toHaveLength(2);
    expect(inserted[0]).toMatchObject({
      ownerType: OWNER_TYPE,
      ownerId: OWNER_ID,
      tenantId: TENANT,
      organizationId: ORG,
      createdBy: USER,
    });
    expect(inserted[1]).toMatchObject({ status: 'awaiting_content', uploadedBy: USER });
    expect(allowsCounterparty).toHaveBeenCalledTimes(1);
    expect(allowsCounterparty).toHaveBeenCalledWith(
      { kind: 'customer', userId: USER, partyId: PARTY, tenantId: TENANT, organizationId: ORG },
      OWNER_ID,
      tx,
    );
  });

  it('refuses with 403 and writes nothing when the owner policy says no', async () => {
    const { service } = setup('refuse');
    const { tx, inserted } = fakeTx();

    await expect(asCaller(caller(), () => service.create(tx, body()))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(inserted).toHaveLength(0);
  });

  it('refuses with 403 when the owner policy has no allowsCounterparty (deny by default)', async () => {
    const { service } = setup('absent');
    const { tx, inserted } = fakeTx();

    await expect(asCaller(caller(), () => service.create(tx, body()))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(inserted).toHaveLength(0);
  });

  it.each([
    ['an inactive customer', caller({ status: 'inactive' })],
    ['an invited customer', caller({ status: 'invited' })],
    ['a customer with no party', caller({ partyId: null })],
    ['a customer with an empty party', caller({ partyId: '' })],
    ['a vendor (until P4 widens the kinds)', caller({ orgKind: 'vendor' })],
    ['staff without the grant', staff()],
    ['a customer of another acting entity', caller({ organizationId: randomUUID() })],
    ['a customer of another tenant', caller({ tenantId: randomUUID() })],
  ])('refuses %s even though the hook would say yes, without asking it', async (_name, p) => {
    const { service, allowsCounterparty } = setup('allow');
    const { tx, inserted } = fakeTx();

    await expect(asCaller(p, () => service.create(tx, body()))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(allowsCounterparty).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('refuses a customer whose transaction runs as another user, without asking the hook', async () => {
    const { service, allowsCounterparty } = setup('allow');
    const { tx, inserted } = fakeTx({ actorId: randomUUID() });

    await expect(asCaller(caller(), () => service.create(tx, body()))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(allowsCounterparty).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('leaves staff with the grant on the grant check: they upload and the hook is never asked', async () => {
    const { service, allowsCounterparty } = setup('allow');
    const { tx, inserted } = fakeTx();

    await asCaller(staff([['documents.upload', 'own']]), () => service.create(tx, body()));

    expect(inserted).toHaveLength(2);
    expect(allowsCounterparty).not.toHaveBeenCalled();
  });

  it('answers 404 for an owner that does not exist in the scope, without asking the hook', async () => {
    const { service, allowsCounterparty } = setup('allow', {
      resource: () => Promise.resolve(null),
    });
    const { tx, inserted } = fakeTx();

    await expect(asCaller(caller(), () => service.create(tx, body()))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(allowsCounterparty).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('still applies canAttach after the hook said yes: a closed owner is a 409 and writes nothing', async () => {
    const { service } = setup('allow', { canAttach: false });
    const { tx, inserted } = fakeTx();

    await expect(asCaller(caller(), () => service.create(tx, body()))).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(inserted).toHaveLength(0);
  });

  it('still applies the type and size limits after the hook said yes', async () => {
    const { service } = setup('allow');
    const { tx, inserted } = fakeTx();

    await expect(
      asCaller(caller(), () =>
        service.create(tx, body({ declaredMime: 'application/x-msdownload' })),
      ),
    ).rejects.toMatchObject({ status: 415 });
    await expect(
      asCaller(caller(), () => service.create(tx, body({ sizeBytes: MAX_UPLOAD_BYTES + 1 }))),
    ).rejects.toMatchObject({ status: 413 });
    expect(inserted).toHaveLength(0);
  });

  it('gives every refusal the same 403 body as staff without the grant gets today', async () => {
    const run = (hook: 'allow' | 'refuse' | 'absent', p: Principal, actorId?: string) => {
      const { service } = setup(hook);
      const { tx } = fakeTx(actorId === undefined ? {} : { actorId });
      return forbiddenBody(asCaller(p, () => service.create(tx, body())));
    };
    const today = await run('absent', staff());
    const bodies = await Promise.all([
      run('refuse', caller()),
      run('absent', caller()),
      run('allow', caller({ status: 'inactive' })),
      run('allow', caller({ partyId: null })),
      run('allow', caller({ orgKind: 'vendor' })),
      run('allow', staff()),
      run('allow', caller({ organizationId: randomUUID() })),
      run('allow', caller(), randomUUID()),
    ]);

    expect(today).toContain('"code":"forbidden"');
    // Inactive callers keep their own reason (inactive_user), as before; every other refusal is no_permission.
    expect(bodies[2]).toContain('"code":"forbidden"');
    const noPermission = bodies.filter((_b, i) => i !== 2);
    expect(new Set(noPermission)).toEqual(new Set([today]));
  });
});

describe('DocumentsService.receiveContent for a portal customer', () => {
  /** A version that already took its bytes: getting past the gate shows up as a 409, not a 403. */
  const received = {
    version: { id: randomUUID(), status: 'quarantined', sizeBytes: 4 },
    ownerType: OWNER_TYPE,
    ownerId: OWNER_ID,
  };
  const who = { scope: SCOPE, actor: { kind: 'user' as const, id: USER, correlationId: 'c-1' } };
  const send = (service: DocumentsService) =>
    service.receiveContent(randomUUID(), Readable.from(Buffer.from('abcd')), 4, { who });

  it('lets a customer the owner policy accepts past the permission gate, asking it in the transaction', async () => {
    const { tx } = fakeTx({ rows: [received] });
    const { service, allowsCounterparty } = setup('allow', { tx });

    await expect(asCaller(caller(), () => send(service))).rejects.toBeInstanceOf(ConflictException);
    expect(allowsCounterparty).toHaveBeenCalledWith(
      { kind: 'customer', userId: USER, partyId: PARTY, tenantId: TENANT, organizationId: ORG },
      OWNER_ID,
      tx,
    );
  });

  it('refuses a customer the owner policy does not accept with the same 403 body', async () => {
    const { tx } = fakeTx({ rows: [received] });
    const refused = setup('refuse', { tx }).service;
    const noHook = setup('absent', { tx }).service;

    const bodies = await Promise.all([
      forbiddenBody(asCaller(caller(), () => send(refused))),
      forbiddenBody(asCaller(caller(), () => send(noHook))),
      forbiddenBody(asCaller(staff(), () => send(noHook))),
    ]);

    expect(bodies[0]).toContain('"code":"forbidden"');
    expect(new Set(bodies).size).toBe(1);
  });
});

describe('the hook opens create and receive only', () => {
  const who = { scope: SCOPE, actor: { kind: 'user' as const, id: USER, correlationId: 'c-1' } };

  it('keeps createVersion closed to a customer the owner policy accepts', async () => {
    const { tx, inserted } = fakeTx({
      rows: [{ id: randomUUID(), ownerType: OWNER_TYPE, ownerId: OWNER_ID }],
    });
    const { service, allowsCounterparty } = setup('allow', { tx });

    await expect(
      asCaller(caller(), () =>
        service.createVersion(tx, randomUUID(), {
          filename: 'proof-2.pdf',
          declaredMime: 'application/pdf',
          sizeBytes: 1234,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(allowsCounterparty).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('keeps remove closed to a customer the owner policy accepts', async () => {
    const { tx } = fakeTx({
      rows: [{ id: randomUUID(), ownerType: OWNER_TYPE, ownerId: OWNER_ID }],
    });
    const { service, allowsCounterparty } = setup('allow', { tx });

    await expect(
      asCaller(caller(), () => service.remove(randomUUID(), { who })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(allowsCounterparty).not.toHaveBeenCalled();
  });
});
