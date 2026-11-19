import { CreateManualInvoiceBodySchema, CreditNoteBodySchema } from '@bos/contracts';
import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import { CUSTOMER, ID, TAX } from '../_lib/test-fixtures';

import {
  currencyNotEnabledMessage,
  parseCreditNote,
  parseDebitNote,
  parseManualInvoice,
  type ManualInvoiceValues,
} from './forms';
import { newLine } from './lines';

vi.mock('server-only', () => ({}));

const goodLine = {
  ...newLine('l1'),
  description: 'Hosting, one year',
  uom: 'yr',
  quantity: '1',
  unitPrice: '12000',
  taxCodeId: TAX,
};

const values = (over: Partial<ManualInvoiceValues> = {}): ManualInvoiceValues => ({
  customerId: CUSTOMER,
  currency: 'NPR',
  manualReason: ' Work done before the order was confirmed. ',
  dueDate: '',
  lines: [goodLine],
  ...over,
});

describe('parseManualInvoice', () => {
  it('builds exactly the contract body, with no number, date or total in it', () => {
    const out = parseManualInvoice(values({ dueDate: '2026-12-08' }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(CreateManualInvoiceBodySchema.safeParse(out.data).success).toBe(true);
    expect(Object.keys(out.data).sort()).toEqual([
      'currency',
      'customerId',
      'dueDate',
      'lines',
      'manualReason',
    ]);
    expect(out.data.manualReason).toBe('Work done before the order was confirmed.');
  });

  it('leaves the due date out when it is blank', () => {
    const out = parseManualInvoice(values());
    expect(out.ok).toBe(true);
    if (out.ok) expect('dueDate' in out.data).toBe(false);
  });

  it('requires a customer, a reason and a real due date', () => {
    const out = parseManualInvoice(
      values({ customerId: '', manualReason: '   ', dueDate: '2026-13-45' }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors['customerId']).toBe('Choose the customer.');
    expect(out.errors['manualReason']).toMatch(/why/i);
    expect(out.errors['dueDate']).toBeTruthy();
  });

  it('refuses a currency outside the three the platform handles and a reason over 1000 characters', () => {
    const out = parseManualInvoice(
      values({ currency: 'EUR' as 'NPR', manualReason: 'r'.repeat(1001) }),
    );
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors['currency']).toBeTruthy();
    expect(out.errors['manualReason']).toContain('1000');
  });

  it('refuses a currency the company has not switched on, naming the ones it may use', () => {
    const out = parseManualInvoice(values({ currency: 'INR' }), ['NPR', 'USD']);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors['currency']).toBe(
      'Choose NPR or USD. Only these currencies are switched on for your company.',
    );
    expect(parseManualInvoice(values({ currency: 'USD' }), ['NPR', 'USD']).ok).toBe(true);
  });

  it('carries line errors through', () => {
    const out = parseManualInvoice(values({ lines: [{ ...goodLine, quantity: '' }] }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors['lines.0.quantity']).toBeTruthy();
  });
});

describe('currencyNotEnabledMessage', () => {
  const refusal = (body: unknown, status = 422) => new ApiError(status, 'refused', body);

  it("words the API's 422 CURRENCY_NOT_ENABLED with the refused currency", () => {
    const err = refusal({
      error: {
        code: 'CURRENCY_NOT_ENABLED',
        message: 'Currency INR is not enabled for this company',
        details: { currency: 'INR' },
      },
    });
    expect(currencyNotEnabledMessage(err)).toBe(
      'INR is no longer switched on for your company. Reload the page and choose another currency.',
    );
  });

  it('echoes only a known currency code and ignores every other failure', () => {
    const odd = refusal({ error: { code: 'CURRENCY_NOT_ENABLED', details: { currency: '<b>' } } });
    expect(currencyNotEnabledMessage(odd)).toMatch(/^This currency is no longer/);
    expect(currencyNotEnabledMessage(refusal({ error: { code: 'OTHER' } }))).toBeUndefined();
    expect(
      currencyNotEnabledMessage(refusal({ error: { code: 'CURRENCY_NOT_ENABLED' } }, 409)),
    ).toBeUndefined();
    expect(currencyNotEnabledMessage(new Error('offline'))).toBeUndefined();
  });
});

describe('parseCreditNote', () => {
  it('names the original invoice, the reason and the lines credited', () => {
    const out = parseCreditNote({
      originalInvoiceId: ID,
      reason: ' Goods returned. ',
      lines: [
        { lineNo: 1, quantity: '' },
        { lineNo: 2, quantity: '1' },
      ],
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(CreditNoteBodySchema.safeParse(out.data).success).toBe(true);
    expect(out.data).toEqual({
      originalInvoiceId: ID,
      reason: 'Goods returned.',
      lines: [{ originalLineNo: 2, quantity: '1' }],
    });
  });

  it('needs a reason and a line', () => {
    const out = parseCreditNote({
      originalInvoiceId: ID,
      reason: '',
      lines: [{ lineNo: 1, quantity: '' }],
    });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.errors['reason']).toMatch(/why/i);
    expect(out.errors['lines']).toBeTruthy();
  });

  it('refuses an original invoice id that is not an id', () => {
    const out = parseCreditNote({
      originalInvoiceId: 'nope',
      reason: 'x',
      lines: [{ lineNo: 1, quantity: '1' }],
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors['form']).toMatch(/incomplete/i);
  });
});

describe('parseDebitNote', () => {
  it('reuses the line rules and needs a reason', () => {
    const ok = parseDebitNote({ originalInvoiceId: ID, reason: 'Late fee', lines: [goodLine] });
    expect(ok.ok).toBe(true);
    const bad = parseDebitNote({
      originalInvoiceId: ID,
      reason: '',
      lines: [{ ...goodLine, taxCodeId: '' }],
    });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors['reason']).toBeTruthy();
    expect(bad.errors['lines.0.taxCodeId']).toBeTruthy();
  });
});
