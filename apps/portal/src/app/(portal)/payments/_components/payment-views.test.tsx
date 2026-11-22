import { MAX_UPLOAD_BYTES } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import type { PortalPaymentListItem } from '@/lib/api.billing';

import { PaymentList } from './payment-list';
import { proofProblem } from './proof-rules';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { PaymentForm } = await import('./payment-form');

const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const INVOICE = { id: '1f8fad5b-d9cb-469f-a165-70867728950e', number: 'INV-2083/84-00001' };

const row = (over: Partial<PortalPaymentListItem> = {}): PortalPaymentListItem => ({
  id: '4f8fad5b-d9cb-469f-a165-70867728950e',
  status: 'submitted',
  number: null,
  method: 'bank_transfer',
  currency: 'NPR',
  amount: '2018180.00',
  receivedOn: '2026-11-09',
  bankReference: 'TXN-1',
  ...over,
});

describe('PaymentList', () => {
  it('shows each payment with its server status, method, reference and formatted amount', () => {
    const html = renderToStaticMarkup(
      <PaymentList
        items={[
          row(),
          row({
            id: '5f8fad5b-d9cb-469f-a165-70867728950e',
            status: 'verified',
            number: 'RCPT-2083/84-00001',
            method: 'qr',
            bankReference: null,
            currency: 'USD',
            amount: '1500.50',
          }),
          row({ id: '6f8fad5b-d9cb-469f-a165-70867728950e', status: 'rejected' }),
        ]}
      />,
    );
    for (const text of [
      'Awaiting verification',
      'Verified',
      'Not accepted',
      'RCPT-2083/84-00001',
      'QR payment',
      'Bank transfer',
      'NPR 20,18,180.00',
      'USD 1,500.50',
      '9 Nov 2026',
      'TXN-1',
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain('—');
    for (const word of ['verifiedBy', 'submittedBy', 'customerId', 'version']) {
      expect(html).not.toContain(word);
    }
  });
});

describe('PaymentForm', () => {
  const render = (over: Partial<Parameters<typeof PaymentForm>[0]> = {}) =>
    renderToStaticMarkup(
      <PaymentForm
        idempotencyKey={KEY}
        today="2026-11-10"
        defaultCurrency="NPR"
        enabledCurrencies={['NPR', 'USD']}
        suggestedAmount=""
        {...over}
      />,
    );

  it('asks for amount, date, method, reference and proof, with the key and no date after today', () => {
    const html = render();
    for (const name of ['amount', 'method', 'receivedOn', 'bankReference', 'currency']) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain('type="file"');
    expect(html).toContain('accept="application/pdf,image/png,image/jpeg,image/webp"');
    expect(html).toContain(`name="idempotencyKey" value="${KEY}"`);
    expect(html).toContain('max="2026-11-10"');
    expect(html).toContain('Submit payment');
    expect(html).not.toContain('name="invoice"');
    expect(html).not.toContain('customer');
  });

  it("from an invoice, names it and prefills the server's currency and open amount", () => {
    const html = render({
      invoice: INVOICE,
      defaultCurrency: 'USD',
      suggestedAmount: '1000000.00',
    });
    expect(html).toContain('Paying invoice');
    expect(html).toContain('INV-2083/84-00001');
    expect(html).toContain(`name="invoice" value="${INVOICE.id}"`);
    expect(html).toContain('name="amount" value="1,000,000.00"');
    expect(html).toContain('<input type="hidden" name="currency" value="USD"/>');
    expect(html).not.toContain('Payments in it are still accepted');
  });

  it('from an invoice in a switched-off currency, starts blank with a note and the open amount', () => {
    const html = render({
      invoice: INVOICE,
      defaultCurrency: 'INR',
      enabledCurrencies: ['NPR', 'USD'],
      suggestedAmount: '1000000.00',
    });
    // Old code started on NPR and dropped the open amount.
    expect(html).toContain('<input type="hidden" name="currency" value=""/>');
    expect(html).toContain(
      'This invoice is in INR, which is switched off for the company. Payments in it are still accepted. The amount filled in is in INR.',
    );
    expect(html).toContain('name="amount" value="1000000.00"');
  });
});

describe('proofProblem', () => {
  const ok = { name: 'slip.pdf', type: 'application/pdf', size: 1024 };

  it('accepts a PDF and the picture types a bank slip comes as', () => {
    expect(proofProblem(ok)).toBeNull();
    for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
      expect(proofProblem({ ...ok, name: 'slip', type })).toBeNull();
    }
  });

  it('refuses other types, empty and oversized files, and names with a path', () => {
    expect(proofProblem({ ...ok, type: 'application/x-msdownload' })).toMatch(/not a PDF/);
    expect(
      proofProblem({
        ...ok,
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }),
    ).toMatch(/not a PDF/);
    expect(proofProblem({ ...ok, size: 0 })).toMatch(/empty/);
    expect(proofProblem({ ...ok, size: MAX_UPLOAD_BYTES })).toBeNull();
    expect(proofProblem({ ...ok, size: MAX_UPLOAD_BYTES + 1 })).toMatch(/larger than 25 MB/);
    expect(proofProblem({ ...ok, name: '../slip.pdf' })).toMatch(/no usable name/);
    expect(proofProblem({ ...ok, name: ' ' })).toMatch(/no usable name/);
  });
});
