// Unit tests of QuotationDocumentService with the database and DocumentsService faked: who may ask (staff only),
// the 404 for a version the store does not return (another entity, another owner, another quotation), the three
// answers for a PDF that cannot be served (409 quotation_pdf_not_ready, also for a failed render with tries left; 424
// quotation_pdf_failed once it was given up; 404 quotation_pdf_unavailable), the happy path that issues the link
// through issueLinkForOwner, and the retry of a given-up render (202 only from `failed` at the try limit, audited, 409
// quotation_pdf_retry_not_needed otherwise). The SQL scope and a link that redeems run on Postgres in
// quotation-document.integration.test.ts.
import type { DocumentVersionDto, Permission, Scope } from '@bos/contracts';
import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Principal } from '../../../platform/authz/principal';
import type { DbTransaction } from '../../../platform/db/db.module';
import { QUOTATION_OWNER_TYPE } from '../quotation-owner.policy';
import { MAX_RENDER_ATTEMPTS } from '../render/render-retry';
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
  renderState: 'rendered',
  renderAttempts: 0,
  status: 'approved',
  ...over,
});
/** A version whose render failed on its last try. */
const givenUp = (over: Partial<QuotationDocumentHead> = {}) =>
  head({
    renderState: 'failed',
    renderAttempts: MAX_RENDER_ATTEMPTS,
    renderedDocumentId: null,
    ...over,
  });

const upload = (over: Partial<DocumentVersionDto> = {}): DocumentVersionDto => ({
  id: id(41),
  documentId: DOCUMENT,
  version: 1,
  filename: 'QT-1-R1.pdf',
  declaredMime: 'application/pdf',
  detectedMime: 'application/pdf',
  sizeBytes: 300,
  sha256: 'cd'.repeat(32),
  status: 'clean',
  scanSignature: null,
  scannedAt: null,
  uploadedBy: null,
  createdAt: '2026-11-09T06:00:00.000Z',
  ...over,
});

function setup(p: Principal = principal()) {
  const store = {
    head: vi.fn().mockResolvedValue(head()),
    requeueFailed: vi.fn().mockResolvedValue(true),
  };
  const documents = {
    issueLinkForOwner: vi.fn().mockResolvedValue(LINK),
    listForOwner: vi.fn().mockResolvedValue([upload()]),
  };
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const nudge = { nudge: vi.fn().mockResolvedValue(undefined) };
  const caller = {
    current: () => ({
      scope: { tenantId: p.tenantId, organizationId: p.organizationId },
      actor: { kind: 'user' as const, id: CALLER, correlationId: 'c-1' },
      principal: p,
    }),
  };
  const service = new QuotationDocumentService(
    {} as never,
    documents as never,
    store,
    caller,
    audit as never,
    nudge as never,
  );
  return { service, store, documents, audit, nudge };
}

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
};

const answerOf = async (promise: Promise<unknown>) => {
  const error = await errorOf(promise);
  expect(error).toBeInstanceOf(HttpException);
  const e = error as HttpException;
  return { status: e.getStatus(), body: e.getResponse() };
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

  it('is a 404 not_found when the store finds no such version in the caller scope, and no link is issued', async () => {
    const { service, store, documents } = setup();
    store.head.mockResolvedValue(undefined);

    const error = await errorOf(service.link(QID, VID));

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({ code: 'not_found' });
    expect(documents.issueLinkForOwner).not.toHaveBeenCalled();
  });

  it.each([
    ['not rendered yet (none)', { renderState: 'none', renderedDocumentId: null }],
    ['being rendered (pending)', { renderState: 'pending', renderedDocumentId: null }],
    [
      'no rendered document although rendered',
      { renderState: 'rendered', renderedDocumentId: null },
    ],
  ] as const)('is a 409 quotation_pdf_not_ready when %s', async (_name, over) => {
    const { service, store, documents } = setup();
    store.head.mockResolvedValue(head({ ...over }));

    const { status, body } = await answerOf(service.link(QID, VID));

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'quotation_pdf_not_ready' });
    expect(documents.issueLinkForOwner).not.toHaveBeenCalled();
  });

  it.each(['awaiting_content', 'quarantined'] as const)(
    'is a 409 quotation_pdf_not_ready while the newest upload is %s',
    async (status) => {
      const { service, documents } = setup();
      documents.listForOwner.mockResolvedValue([upload({ status })]);

      const answer = await answerOf(service.link(QID, VID));

      expect(answer.status).toBe(409);
      expect(answer.body).toMatchObject({ code: 'quotation_pdf_not_ready' });
      expect(documents.issueLinkForOwner).not.toHaveBeenCalled();
    },
  );

  it('is a 409 quotation_pdf_not_ready, never "failed", while a failed render still has tries left', async () => {
    const { service, store, documents } = setup();
    for (let attempts = 0; attempts < MAX_RENDER_ATTEMPTS; attempts += 1) {
      store.head.mockResolvedValue(
        head({ renderState: 'failed', renderAttempts: attempts, renderedDocumentId: null }),
      );
      const { status, body } = await answerOf(service.link(QID, VID));
      expect(status).toBe(409);
      expect(body).toMatchObject({ code: 'quotation_pdf_not_ready' });
    }
    expect(documents.issueLinkForOwner).not.toHaveBeenCalled();
  });

  it('is a 424 quotation_pdf_failed when the render was given up, with its message and no link', async () => {
    const { service, store, documents } = setup();
    store.head.mockResolvedValue(givenUp());

    const { status, body } = await answerOf(service.link(QID, VID));

    expect(status).toBe(424);
    expect(body).toEqual({
      code: 'quotation_pdf_failed',
      message: 'The PDF could not be prepared',
    });
    expect(documents.listForOwner).not.toHaveBeenCalled();
    expect(documents.issueLinkForOwner).not.toHaveBeenCalled();
  });

  it.each(['infected', 'rejected', 'scan_failed'] as const)(
    'is a 404 quotation_pdf_unavailable when the newest upload is %s',
    async (status) => {
      const { service, documents } = setup();
      documents.listForOwner.mockResolvedValue([upload({ status })]);

      const answer = await answerOf(service.link(QID, VID));

      expect(answer.status).toBe(404);
      expect(answer.body).toEqual({
        code: 'quotation_pdf_unavailable',
        message: 'This PDF is not available',
      });
      expect(documents.issueLinkForOwner).not.toHaveBeenCalled();
    },
  );

  it('is a 404 quotation_pdf_unavailable when the rendered document was removed (not listed)', async () => {
    const { service, documents } = setup();
    documents.listForOwner.mockResolvedValue([upload({ documentId: id(99) })]);

    const answer = await answerOf(service.link(QID, VID));

    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ code: 'quotation_pdf_unavailable' });
    expect(documents.issueLinkForOwner).not.toHaveBeenCalled();
  });

  it('judges the newest upload of the document, not an older clean one', async () => {
    const { service, documents } = setup();
    documents.listForOwner.mockResolvedValue([
      upload({ version: 1, status: 'clean' }),
      upload({ version: 2, status: 'infected' }),
    ]);

    const answer = await answerOf(service.link(QID, VID));

    expect(answer.body).toMatchObject({ code: 'quotation_pdf_unavailable' });
    expect(documents.issueLinkForOwner).not.toHaveBeenCalled();
  });

  it('is a 404 quotation_pdf_unavailable when a clean file is refused at issue time (removed meanwhile)', async () => {
    const { service, documents } = setup();
    documents.issueLinkForOwner.mockRejectedValue(new NotFoundException('File not found'));

    const answer = await answerOf(service.link(QID, VID));

    expect(answer.status).toBe(404);
    expect(answer.body).toMatchObject({ code: 'quotation_pdf_unavailable' });
  });

  it('lets any other failure of the documents module through unchanged', async () => {
    const { service, documents } = setup();
    const boom = new Error('storage down');
    documents.issueLinkForOwner.mockRejectedValue(boom);

    expect(await errorOf(service.link(QID, VID))).toBe(boom);
  });
});

describe('QuotationDocumentService.retry', () => {
  it('requeues a given-up render in the caller transaction, audits it and answers queued', async () => {
    const { service, store, audit, nudge } = setup();
    store.head.mockResolvedValue(givenUp());

    await expect(service.retry(QID, VID)).resolves.toEqual({ state: 'queued' });

    // The render is enqueued at once, after the commit, not left to the next sweep.
    expect(nudge.nudge).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ tenantId: TENANT, organizationId: ORG }),
      VID,
    );

    expect(store.head).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ userId: CALLER }),
      QID,
      VID,
      'quotation.send',
    );
    expect(store.requeueFailed).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({ tenantId: TENANT, organizationId: ORG }),
      VID,
      expect.any(Date),
    );
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        action: 'quotation.pdf_retry_requested',
        entityType: 'quotations',
        entityId: QID,
        before: { versionId: VID, renderState: 'failed', renderAttempts: MAX_RENDER_ATTEMPTS },
        after: { versionId: VID, renderState: 'none', renderAttempts: 0 },
      }),
    );
  });

  it.each(['none', 'pending', 'rendered'] as const)(
    'is a 409 quotation_pdf_retry_not_needed when the render state is %s, and changes nothing',
    async (renderState) => {
      const { service, store, audit } = setup();
      store.head.mockResolvedValue(head({ renderState }));

      const { status, body } = await answerOf(service.retry(QID, VID));

      expect(status).toBe(409);
      expect(body).toMatchObject({ code: 'quotation_pdf_retry_not_needed' });
      expect(store.requeueFailed).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('is a 409 quotation_pdf_retry_not_needed while a failed render still has tries left, and changes nothing', async () => {
    const { service, store, audit } = setup();
    store.head.mockResolvedValue(
      head({ renderState: 'failed', renderAttempts: MAX_RENDER_ATTEMPTS - 1 }),
    );

    const { status, body } = await answerOf(service.retry(QID, VID));

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'quotation_pdf_retry_not_needed' });
    expect(store.requeueFailed).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it.each([
    'draft',
    'submitted',
    'returned',
    'sent',
    'accepted',
    'rejected',
    'expired',
    'cancelled',
    'superseded',
  ] as const)(
    'is a 409 quotation_pdf_retry_not_needed for a failed render of a %s version (the sweeper renders only approved), and changes nothing',
    async (status) => {
      const { service, store, audit } = setup();
      store.head.mockResolvedValue(givenUp({ status }));

      const { status: http, body } = await answerOf(service.retry(QID, VID));

      expect(http).toBe(409);
      expect(body).toMatchObject({ code: 'quotation_pdf_retry_not_needed' });
      expect(store.requeueFailed).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    },
  );

  it('is a 409 and writes no audit row when another click or the sweeper moved the version first', async () => {
    const { service, store, audit } = setup();
    store.head.mockResolvedValue(givenUp());
    store.requeueFailed.mockResolvedValue(false);

    const { status, body } = await answerOf(service.retry(QID, VID));

    expect(status).toBe(409);
    expect(body).toMatchObject({ code: 'quotation_pdf_retry_not_needed' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('is a 404 not_found for a version outside the caller scope', async () => {
    const { service, store, audit } = setup();
    store.head.mockResolvedValue(undefined);

    const error = await errorOf(service.retry(QID, VID));

    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).getResponse()).toMatchObject({ code: 'not_found' });
    expect(store.requeueFailed).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('is a 403 for a portal caller, before anything is read', async () => {
    const { service, store } = setup(principal({ orgKind: 'customer' }));

    expect(await errorOf(service.retry(QID, VID))).toBeInstanceOf(ForbiddenException);
    expect(store.head).not.toHaveBeenCalled();
    expect(store.requeueFailed).not.toHaveBeenCalled();
  });
});
