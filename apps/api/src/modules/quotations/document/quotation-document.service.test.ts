// Unit tests of QuotationDocumentService with the database and DocumentsService faked: who may ask (staff only),
// the 404 for a version the store does not return (another entity, another owner, another quotation), the 409
// quotation_pdf_not_ready when there is no rendered file or it is not clean, and the happy path that issues the
// link through issueLinkForOwner. The SQL scope and a link that redeems run on Postgres in
// quotation-document.integration.test.ts.
import type { Permission, Scope } from '@bos/contracts';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../../platform/authz/principal';
import type { DbTransaction } from '../../../platform/db/db.module';
import { QUOTATION_OWNER_TYPE } from '../quotation-owner.policy';
import { QuotationDocumentService, type QuotationDocumentHead } from './quotation-document.service';

const TX = { fake: 'tx' } as unknown as DbTransaction;

vi.mock('../../../platform/db/tx', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../platform/db/tx')>()),
  withTx: vi.fn((_db: unknown, _scope: unknown, _actor: unknown, fn: (tx: unknown) => unknown) =>
    fn(TX),
  ),
}));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const TENANT = id(1);
const ORG = id(2);
const QID = id(10);
const VID = id(11);
const DOCUMENT = id(40);
const CALLER = id(51);
const LINK = { url: '/v1/files/token', expiresAt: '2026-11-09T06:01:00.000Z' };

const principal = (over: Partial<Principal> = {}): Principal => ({
  userId: CALLER,
  zitadelUserId: 'z-1',
  tenantId: TENANT,
  organizationId: ORG,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: 'unused',
  roles: [],
  departmentId: null,
  status: 'active',
  grants: new Map<Permission, Scope>([['quotation.read', 'all']]),
  ...over,
});

const head = (over: Partial<QuotationDocumentHead> = {}): QuotationDocumentHead => ({
  tenantId: TENANT,
  organizationId: ORG,
  renderedDocumentId: DOCUMENT,
  ...over,
});

function setup(p: Principal = principal()) {
  const store = { head: vi.fn().mockResolvedValue(head()) };
  const documents = { issueLinkForOwner: vi.fn().mockResolvedValue(LINK) };
  const caller = {
    current: () => ({
      scope: { tenantId: p.tenantId, organizationId: p.organizationId },
      actor: { kind: 'user' as const, id: CALLER, correlationId: 'c-1' },
      principal: p,
    }),
  };
  const service = new QuotationDocumentService({} as never, documents as never, store, caller);
  return { service, store, documents };
}

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
};

beforeEach(() => vi.clearAllMocks());

describe('QuotationDocumentService.link', () => {
  it('issues the link for the rendered document of the version, in the quotation entity', async () => {
    const { service, store, documents } = setup();

    await expect(service.link(QID, VID)).resolves.toEqual(LINK);

    expect(store.head).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ userId: CALLER }),
      QID,
      VID,
    );
    expect(documents.issueLinkForOwner).toHaveBeenCalledTimes(1);
    expect(documents.issueLinkForOwner).toHaveBeenCalledWith(
      { tenantId: TENANT, organizationId: ORG },
      { ownerType: QUOTATION_OWNER_TYPE, ownerId: VID },
      DOCUMENT,
    );
  });

  it('is a 403 for a portal caller, before anything is read', async () => {
    const { service, store, documents } = setup(principal({ orgKind: 'customer' }));

    expect(await errorOf(service.link(QID, VID))).toBeInstanceOf(ForbiddenException);
    expect(store.head).not.toHaveBeenCalled();
    expect(documents.issueLinkForOwner).not.toHaveBeenCalled();
  });

  it('is a 404 when the store finds no such version in the caller scope, and no link is issued', async () => {
    const { service, store, documents } = setup();
    store.head.mockResolvedValue(undefined);

    expect(await errorOf(service.link(QID, VID))).toBeInstanceOf(NotFoundException);
    expect(documents.issueLinkForOwner).not.toHaveBeenCalled();
  });

  it('is a 409 quotation_pdf_not_ready when the version has no rendered document', async () => {
    const { service, store, documents } = setup();
    store.head.mockResolvedValue(head({ renderedDocumentId: null }));

    const error = await errorOf(service.link(QID, VID));

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'quotation_pdf_not_ready',
    });
    expect(documents.issueLinkForOwner).not.toHaveBeenCalled();
  });

  it('is a 409 quotation_pdf_not_ready when the document is not clean (the documents module answers 404)', async () => {
    const { service, documents } = setup();
    documents.issueLinkForOwner.mockRejectedValue(new NotFoundException('File not found'));

    const error = await errorOf(service.link(QID, VID));

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({
      code: 'quotation_pdf_not_ready',
    });
  });

  it('lets any other failure of the documents module through unchanged', async () => {
    const { service, documents } = setup();
    const boom = new Error('storage down');
    documents.issueLinkForOwner.mockRejectedValue(boom);

    expect(await errorOf(service.link(QID, VID))).toBe(boom);
  });
});
