// createGenerated (kernel gap M14): a job writes a generated file under the system actor. Unit level: the
// system path never asks the request principal's authz, always asks the owner's policy for the system actor,
// and a refusal writes nothing. The scan pipeline and the stored sha256 are in documents.integration.test.ts.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { Db, DbTransaction } from '../db/tx';
import type { DocumentOwnerPolicy } from './documents.ports';
import { DocumentsService, type GeneratedFile } from './documents.service';
import type { StorageAdapter } from './storage.adapter';
import type { SignedLinks } from './signed-link';

const TENANT = randomUUID();
const ORG = randomUUID();
const OWNER_ID = randomUUID();
const SYSTEM = 'system:quotation.pdf';

/** A transaction that answers readTxContext (the bos.* settings withTx sets) and records every insert. */
function fakeTx(over: { actorKind?: string; actorId?: string } = {}) {
  const inserted: { table: unknown; values: Record<string, unknown> }[] = [];
  const tx = {
    execute: vi.fn().mockResolvedValue({
      rows: [
        {
          tenant_id: TENANT,
          organization_id: ORG,
          actor_id: over.actorId ?? SYSTEM,
          actor_kind: over.actorKind ?? 'system',
        },
      ],
    }),
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserted.push({ table, values });
        return Promise.resolve();
      },
    })),
  };
  return { tx: tx as unknown as DbTransaction, inserted };
}

const pdf = (over: Partial<GeneratedFile> = {}): GeneratedFile => ({
  filename: 'Q-2026-0001.pdf',
  declaredMime: 'application/pdf',
  bytes: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n%%EOF\n'),
  ...over,
});

function setup(policy?: Partial<DocumentOwnerPolicy>, opts: { noSystemHook?: boolean } = {}) {
  const authz = { assert: vi.fn() };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const service = new DocumentsService(
    {} as Db,
    {} as StorageAdapter,
    {} as SignedLinks,
    { add: vi.fn() } as unknown as Queue,
    authz,
    audit,
  );
  const resource = vi.fn((scope: { tenantId: string; organizationId: string }) =>
    Promise.resolve({ tenantId: scope.tenantId, organizationId: scope.organizationId }),
  );
  const allowsSystemActor = vi.fn().mockResolvedValue(true);
  const canAttach = vi.fn().mockResolvedValue(true);
  const registered: DocumentOwnerPolicy = {
    ownerType: 'quotation',
    resource,
    canAttach,
    ...(opts.noSystemHook === true ? {} : { allowsSystemActor }),
    ...policy,
  };
  service.registerOwner(registered);
  return { service, authz, resource, allowsSystemActor, canAttach };
}

const owner = { ownerType: 'quotation', ownerId: OWNER_ID };

describe('DocumentsService.createGenerated', () => {
  it('skips the principal authz check but asks the owner policy for the system actor', async () => {
    const { service, authz, allowsSystemActor, resource } = setup();
    const { tx, inserted } = fakeTx();

    const created = await service.createGenerated(tx, owner, pdf());

    expect(authz.assert).not.toHaveBeenCalled();
    expect(resource).toHaveBeenCalledWith({ tenantId: TENANT, organizationId: ORG }, OWNER_ID);
    expect(allowsSystemActor).toHaveBeenCalledTimes(1);
    expect(allowsSystemActor).toHaveBeenCalledWith(
      { tenantId: TENANT, organizationId: ORG },
      OWNER_ID,
      { kind: 'system', id: SYSTEM },
      tx,
    );
    // A document row and an awaiting_content version 1, scoped to the job's tenant and entity, with no user.
    expect(inserted).toHaveLength(2);
    expect(inserted[0]?.values).toMatchObject({
      id: created.documentId,
      ownerType: 'quotation',
      ownerId: OWNER_ID,
      tenantId: TENANT,
      organizationId: ORG,
      createdBy: null,
    });
    expect(inserted[1]?.values).toMatchObject({
      id: created.versionId,
      documentId: created.documentId,
      version: 1,
      filename: 'Q-2026-0001.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: pdf().bytes.length,
      status: 'awaiting_content',
      uploadedBy: null,
    });
  });

  it('writes no row when the owner policy refuses the system actor', async () => {
    const { service, authz } = setup({ allowsSystemActor: vi.fn().mockResolvedValue(false) });
    const { tx, inserted } = fakeTx();

    await expect(service.createGenerated(tx, owner, pdf())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(inserted).toHaveLength(0);
    expect(authz.assert).not.toHaveBeenCalled();
  });

  it('refuses an owner whose policy does not implement allowsSystemActor (deny by default)', async () => {
    const { service } = setup({}, { noSystemHook: true });
    const { tx, inserted } = fakeTx();

    await expect(service.createGenerated(tx, owner, pdf())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(inserted).toHaveLength(0);
  });

  it('refuses a transaction that is not the system actor, so it cannot skip the user authz check', async () => {
    const { service, allowsSystemActor, resource } = setup();
    const { tx, inserted } = fakeTx({ actorKind: 'user', actorId: randomUUID() });

    await expect(service.createGenerated(tx, owner, pdf())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(inserted).toHaveLength(0);
    expect(resource).not.toHaveBeenCalled();
    expect(allowsSystemActor).not.toHaveBeenCalled();
  });

  it('answers 404 for an owner that does not exist in the scope, without asking the policy', async () => {
    const { service, allowsSystemActor } = setup({ resource: () => Promise.resolve(null) });
    const { tx, inserted } = fakeTx();

    await expect(service.createGenerated(tx, owner, pdf())).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(allowsSystemActor).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(0);
  });

  it('is a 400 for an unknown owner type, an empty file or an unsafe file name', async () => {
    const { service } = setup();
    const { tx, inserted } = fakeTx();

    await expect(
      service.createGenerated(tx, { ownerType: 'nope', ownerId: OWNER_ID }, pdf()),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createGenerated(tx, owner, pdf({ bytes: Buffer.alloc(0) })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.createGenerated(tx, owner, pdf({ filename: '../etc/passwd' })),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(inserted).toHaveLength(0);
  });

  it('applies the upload type allow-list: a type outside it is refused and writes nothing', async () => {
    const { service } = setup();
    const { tx, inserted } = fakeTx();

    await expect(
      service.createGenerated(tx, owner, pdf({ declaredMime: 'application/x-msdownload' })),
    ).rejects.toMatchObject({ status: 415 });
    expect(inserted).toHaveLength(0);
  });
});

describe('DocumentsService.receiveGenerated', () => {
  it('refuses a user actor before touching storage or the database', async () => {
    const { service } = setup();
    const who = {
      scope: { tenantId: TENANT, organizationId: ORG },
      actor: { kind: 'user' as const, id: randomUUID(), correlationId: 'c-1' },
    };

    await expect(
      service.receiveGenerated({ documentId: randomUUID(), versionId: randomUUID() }, pdf(), who),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// issueLinkForOwner (PA-doc): the owning module (the customer portal) authorized the owner already, so the
// principal's authz is never asked. Every refusal is the same 404, so a caller learns nothing about whether a
// document exists. The scoping of the query itself is proven against Postgres in
// documents.owner-link.integration.test.ts.
describe('DocumentsService.issueLinkForOwner', () => {
  const DOC_ID = randomUUID();
  const VERSION_ID = randomUUID();
  const versionOwner = { ownerType: 'quotation', ownerId: OWNER_ID };
  const scope = { tenantId: TENANT, organizationId: ORG };

  type Row = { version: { id: string; status: string } };
  interface Chain {
    from(): Chain;
    innerJoin(): Chain;
    where(): Chain;
    orderBy(): Chain;
    limit(): Promise<Row[]>;
  }

  /** A db whose select chain resolves to `rows`; `select` counts the queries. */
  function linkSetup(rows: Row[]) {
    const chain: Chain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      orderBy: () => chain,
      limit: () => Promise.resolve(rows),
    };
    const db = { select: vi.fn(() => chain) };
    const authz = { assert: vi.fn() };
    const links = {
      issue: vi.fn(() => ({ token: 'signed-token', expiresAt: new Date('2026-11-09T00:01:00Z') })),
    };
    const service = new DocumentsService(
      db as unknown as Db,
      {} as StorageAdapter,
      links as unknown as SignedLinks,
      { add: vi.fn() } as unknown as Queue,
      authz,
      { record: vi.fn() },
    );
    service.registerOwner({
      ownerType: 'quotation',
      resource: () => Promise.resolve({ tenantId: TENANT, organizationId: ORG }),
    });
    return { service, db, authz, links };
  }

  const clean = { version: { id: VERSION_ID, status: 'clean' } };

  it('signs the newest version id (not the document id) without asking the principal authz', async () => {
    const { service, authz, links } = linkSetup([clean]);

    const link = await service.issueLinkForOwner(scope, versionOwner, DOC_ID);

    expect(link).toEqual({ url: '/v1/files/signed-token', expiresAt: '2026-11-09T00:01:00.000Z' });
    expect(links.issue).toHaveBeenCalledTimes(1);
    expect(links.issue).toHaveBeenCalledWith(VERSION_ID);
    expect(authz.assert).not.toHaveBeenCalled();
  });

  it.each(['quarantined', 'awaiting_content', 'infected', 'scan_failed', 'rejected'])(
    'is a 404 when the newest version is %s, and issues no link',
    async (status) => {
      const { service, links } = linkSetup([{ version: { id: VERSION_ID, status } }]);

      await expect(service.issueLinkForOwner(scope, versionOwner, DOC_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(links.issue).not.toHaveBeenCalled();
    },
  );

  it('is a 404 when no document of that owner matches in the scope', async () => {
    const { service, links } = linkSetup([]);

    await expect(service.issueLinkForOwner(scope, versionOwner, DOC_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(links.issue).not.toHaveBeenCalled();
  });

  it('is a 404, not a 403, for an owner type nobody registered, without querying', async () => {
    const { service, db, links } = linkSetup([clean]);

    await expect(
      service.issueLinkForOwner(scope, { ownerType: 'nope', ownerId: OWNER_ID }, DOC_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.select).not.toHaveBeenCalled();
    expect(links.issue).not.toHaveBeenCalled();
  });

  it('is a 404 for an id that is not a UUID, before it can reach Postgres', async () => {
    const { service, db } = linkSetup([clean]);

    await expect(
      service.issueLinkForOwner(scope, versionOwner, 'not-a-uuid'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.issueLinkForOwner(scope, { ownerType: 'quotation', ownerId: "1' OR 1=1" }, DOC_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.select).not.toHaveBeenCalled();
  });

  it('gives the same 404 body for every refusal, so existence never leaks', async () => {
    const bodies = await Promise.all(
      [
        () => linkSetup([]).service.issueLinkForOwner(scope, versionOwner, DOC_ID),
        () =>
          linkSetup([
            { version: { id: VERSION_ID, status: 'quarantined' } },
          ]).service.issueLinkForOwner(scope, versionOwner, DOC_ID),
        () =>
          linkSetup([clean]).service.issueLinkForOwner(
            scope,
            { ownerType: 'nope', ownerId: OWNER_ID },
            DOC_ID,
          ),
        () => linkSetup([clean]).service.issueLinkForOwner(scope, versionOwner, 'x'),
      ].map((call) =>
        call().then(
          () => 'resolved',
          (e: unknown) => (e instanceof NotFoundException ? JSON.stringify(e.getResponse()) : e),
        ),
      ),
    );
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toBe('resolved');
  });
});
