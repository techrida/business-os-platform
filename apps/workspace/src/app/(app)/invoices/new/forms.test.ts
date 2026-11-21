import { CreateManualInvoiceBodySchema, CreditNoteBodySchema } from '@bos/contracts';
import { describe, expect, it, vi } from 'vitest';

import { CUSTOMER, ID, TAX } from '../_lib/test-fixtures';

import {
  parseCreditNote,
  parseDebitNote,
  parseDiscount,
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

  it('adds the document discount to the contract body only when one is chosen', () => {
    const out = parseManualInvoice(values({ discountMode: 'pct', discountValue: '5' }));
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(CreateManualInvoiceBodySchema.safeParse(out.data).success).toBe(true);
    expect(out.data.discount).toEqual({ mode: 'pct', value: '5' });
    const none = parseManualInvoice(values({ discountMode: 'none', discountValue: '5' }));
    expect(none.ok && 'discount' in none.data).toBe(false);
  });

  it('names a discount problem on the discount field', () => {
    const out = parseManualInvoice(values({ discountMode: 'amount', discountValue: '' }));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors['discount']).toMatch(/Enter the discount/);
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

describe('parseDiscount: a decimal comma is never grouping', () => {
  it.each(['1,5', '10,50', '1,25'])('refuses an amount of %s and says to use a point', (typed) => {
    const out = parseDiscount('amount', typed);
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/^Use a point for decimals\./);
  });
});

describe('parseDiscount', () => {
  it.each(['1 5', '1 0.5'])(
    'refuses the percentage %j: a space inside is not grouping',
    (typed) => {
      expect(parseDiscount('pct', typed).ok).toBe(false);
    },
  );

  it.each<[string | undefined, string | undefined, unknown]>([
    [undefined, undefined, undefined],
    ['', '', undefined],
    ['none', '12', undefined],
    ['pct', '0', { mode: 'pct', value: '0' }],
    ['pct', '33.3333', { mode: 'pct', value: '33.3333' }],
    ['amount', ' 1,00,000.50 ', { mode: 'amount', value: '100000.50' }],
    ['amount', '12,50,000.00', { mode: 'amount', value: '1250000.00' }],
    ['amount', '1,250,000.50', { mode: 'amount', value: '1250000.50' }],
  ])('%s %j sends %j', (mode, value, data) => {
    expect(parseDiscount(mode, value)).toEqual({ ok: true, data });
  });

  it.each([
    ['pct', '100'],
    ['pct', '1,5'],
    ['pct', '100.5'],
    ['pct', '-1'],
    ['pct', '1.23456'],
    ['amount', '-5'],
    ['amount', '1.005'],
    ['amount', 'ten'],
    ['pct', ''],
    ['bogus', '5'],
  ])('refuses %s %j', (mode, value) => {
    expect(parseDiscount(mode, value).ok).toBe(false);
  });
});
