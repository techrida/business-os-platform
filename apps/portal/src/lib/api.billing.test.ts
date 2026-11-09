import type { PortalSubmitPaymentBody } from '@bos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  sampleInvoice,
  sampleListItem,
  sampleSettlement,
} from '../app/(portal)/invoices/_components/invoice-fixtures';
import { ApiError } from './api';
import {
  getPortalInvoice,
  getPortalInvoiceLink,
  getPortalInvoiceSettlement,
  listPortalInvoices,
  listPortalPayments,
  submitPortalPayment,
  uploadPaymentProof,
} from './api.billing';
import { callOf, ID, IDEM, json, session, stubPortalEnv } from './billing-test-support';

vi.mock('server-only', () => ({}));

const fetchMock = vi.fn<typeof fetch>();
const BODY: PortalSubmitPaymentBody = {
  currency: 'NPR',
  amount: '2018180.00',
  tdsWithheld: '0.00',
  method: 'bank_transfer',
  receivedOn: '2026-11-09',
  proofDocumentIds: ['2f8fad5b-d9cb-469f-a165-70867728950e'],
};

beforeEach(() => {
  stubPortalEnv();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function statusOf(p: Promise<unknown>): Promise<number | undefined> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  return err instanceof ApiError ? err.status : undefined;
}

describe('invoice reads', () => {
  it('lists the issued invoices from /v1/portal/invoices with the bearer token', async () => {
    fetchMock.mockResolvedValue(json([sampleListItem()]));
    expect(await listPortalInvoices(session)).toEqual([sampleListItem()]);
    const { url, headers, init } = callOf(fetchMock);
    expect(url).toBe('http://api:3001/v1/portal/invoices');
    expect(headers.get('authorization')).toBe(`Bearer ${session.accessToken}`);
    expect(init.cache).toBe('no-store');
  });

  it('reads one invoice and its settlement, encoding the id as one path segment', async () => {
    fetchMock.mockResolvedValueOnce(json(sampleInvoice()));
    expect((await getPortalInvoice(session, ID)).number).toBe('INV-2083/84-00001');
    expect(callOf(fetchMock).url).toBe(`http://api:3001/v1/portal/invoices/${ID}`);

    fetchMock.mockResolvedValueOnce(json({ ...sampleSettlement(), customerId: ID, number: 'X' }));
    const s = await getPortalInvoiceSettlement(session, ID);
    expect(s.settlement).toBe('unpaid');
    // Only the whitelisted fields survive.
    expect(Object.keys(s).sort()).toEqual(
      [
        'currency',
        'dueDate',
        'daysOverdue',
        'invoiceId',
        'openAmount',
        'settlement',
        'total',
      ].sort(),
    );

    fetchMock.mockResolvedValueOnce(json(sampleInvoice()));
    await getPortalInvoice(session, '../admin');
    expect(callOf(fetchMock).url).toBe('http://api:3001/v1/portal/invoices/..%2Fadmin');
  });

  it('answers 404 as 404 and 403 as 403, so the page can show one not-found', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'not_found' } }, 404));
    expect(await statusOf(getPortalInvoice(session, ID))).toBe(404);
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'forbidden' } }, 403));
    expect(await statusOf(getPortalInvoice(session, ID))).toBe(403);
  });

  it('turns a draft-shaped body into 404, never a 502 that would reveal it exists', async () => {
    for (const body of [
      { ...sampleInvoice(), number: null },
      { ...sampleInvoice(), kind: 'proforma' },
      { ...sampleInvoice(), status: 'draft' },
      { id: ID, status: 'draft', number: null, customerId: ID },
    ]) {
      fetchMock.mockResolvedValueOnce(json(body));
      expect(await statusOf(getPortalInvoice(session, ID))).toBe(404);
    }
  });

  it('refuses a body with any internal field, as a 502 with nothing of the body in the message', async () => {
    fetchMock.mockResolvedValueOnce(json({ ...sampleInvoice(), amountNpr: '1.00' }));
    const err = await getPortalInvoice(session, ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
    expect((err as ApiError).message).not.toContain('amountNpr');
    fetchMock.mockResolvedValueOnce(json([{ ...sampleListItem(), status: 'draft' }]));
    expect(await statusOf(listPortalInvoices(session))).toBe(502);
  });

  it('asks for the invoice PDF link at /document', async () => {
    fetchMock.mockResolvedValue(
      json({ url: '/v1/files/tok-1', expiresAt: '2026-11-09T10:00:00Z' }),
    );
    expect((await getPortalInvoiceLink(session, ID)).url).toBe('/v1/files/tok-1');
    expect(callOf(fetchMock).url).toBe(`http://api:3001/v1/portal/invoices/${ID}/document`);
  });
});

describe('payments', () => {
  const row = {
    id: ID,
    status: 'submitted',
    number: null,
    method: 'bank_transfer',
    currency: 'NPR',
    amount: '2018180.00',
    receivedOn: '2026-11-09',
    bankReference: 'TXN-1',
  };

  it('lists the customer payments and refuses a staff field', async () => {
    fetchMock.mockResolvedValueOnce(json([row]));
    expect(await listPortalPayments(session)).toEqual([row]);
    expect(callOf(fetchMock).url).toBe('http://api:3001/v1/portal/payments');
    fetchMock.mockResolvedValueOnce(json([{ ...row, verifiedBy: ID, npr: null }]));
    expect(await statusOf(listPortalPayments(session))).toBe(502);
  });

  it('submits with the Idempotency-Key, and reuses the very same key and body on a retry', async () => {
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
    expect(await statusOf(submitPortalPayment(session, BODY, IDEM))).toBe(503);
    fetchMock.mockResolvedValueOnce(json({ id: ID }, 201));
    await submitPortalPayment(session, BODY, IDEM);
    const [first, second] = fetchMock.mock.calls.map(([url, init]) => ({
      url: (url as URL | string).toString(),
      key: new Headers(init?.headers).get('idempotency-key'),
      body: init?.body,
    }));
    expect(first?.url).toBe('http://api:3001/v1/portal/payments');
    expect(first?.key).toBe(IDEM);
    expect(second).toEqual(first);
    expect(JSON.parse(second?.body as string)).toEqual(BODY);
  });

  it('never sends a customer id or any field outside the contract', async () => {
    const extra = { ...BODY, customerId: ID } as unknown as PortalSubmitPaymentBody;
    await expect(submitPortalPayment(session, extra, IDEM)).rejects.toThrow();
    await expect(
      submitPortalPayment(session, { ...BODY, proofDocumentIds: [] }, IDEM),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('proof upload', () => {
  const file = (body = 'bytes') => ({
    filename: 'slip.pdf',
    mime: 'application/pdf',
    size: body.length,
    body: new Blob([body]).stream(),
  });
  const PATH = `/v1/portal/payment-proofs/${ID}/versions/${IDEM}/content`;

  it('announces the file, then PUTs the bytes with their own type, and returns the document id', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ documentId: ID, versionId: IDEM, uploadPath: PATH }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await uploadPaymentProof(session, file())).toBe(ID);
    const [announce, put] = [callOf(fetchMock, 0), callOf(fetchMock, 1)];
    expect(announce.url).toBe('http://api:3001/v1/portal/payment-proofs');
    expect(JSON.parse(announce.init.body as string)).toEqual({
      filename: 'slip.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 5,
    });
    expect(put.url).toBe(`http://api:3001${PATH}`);
    expect(put.init.method).toBe('PUT');
    expect(put.headers.get('content-type')).toBe('application/pdf');
  });

  it('refuses an upload path of another shape before sending the token or the bytes to it', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ documentId: ID, versionId: IDEM, uploadPath: '/v1/documents/x/content' }, 201),
    );
    expect(await statusOf(uploadPaymentProof(session, file()))).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
