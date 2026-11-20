import { ArAgingReportSchema, InvoiceSettlementSchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  agingReport,
  agingRowKey,
  contractAgingBucket,
  daysOverdue,
  kathmanduDay,
  settlementRow,
} from './receivables.rules';

describe('contractAgingBucket', () => {
  // money-rules buckets 1-15 and 16-30 both fold into the contract's d1_30.
  it.each([
    ['2026-11-09', 'current'],
    ['2026-11-08', 'd1_30'],
    ['2026-10-25', 'd1_30'],
    ['2026-10-24', 'd1_30'],
    ['2026-10-10', 'd1_30'],
    ['2026-10-09', 'd31_60'],
    ['2026-09-10', 'd31_60'],
    ['2026-09-09', 'd61_90'],
    ['2026-08-11', 'd61_90'],
    ['2026-08-10', 'd91_plus'],
    ['2026-12-01', 'current'],
  ])('due %s, today 2026-11-09 -> %s', (due, bucket) => {
    expect(contractAgingBucket(due, '2026-11-09')).toBe(bucket);
  });
});

describe('daysOverdue', () => {
  it('is 0 before and on the due date and counts calendar days after it', () => {
    expect(daysOverdue('2026-11-10', '2026-11-09')).toBe(0);
    expect(daysOverdue('2026-11-09', '2026-11-09')).toBe(0);
    expect(daysOverdue('2026-10-09', '2026-11-09')).toBe(31);
  });
});

describe('kathmanduDay', () => {
  it('takes the calendar day in Asia/Kathmandu (UTC+05:45)', () => {
    expect(kathmanduDay(new Date('2026-11-08T18:14:00Z'))).toBe('2026-11-08');
    expect(kathmanduDay(new Date('2026-11-08T18:15:00Z'))).toBe('2026-11-09');
  });
});

const invoice = {
  invoiceId: '00000000-0000-4000-8000-000000000001',
  number: 'INV-2083/84-00001',
  kind: 'tax_invoice' as const,
  customerId: '00000000-0000-4000-8000-000000000002',
  currency: 'NPR' as const,
  issueDate: '2026-11-01',
  dueDate: '2026-12-01',
  total: '1000.00',
};

describe('settlementRow', () => {
  it('is unpaid with nothing allocated', () => {
    const row = settlementRow({ ...invoice, allocated: '0', credited: '0' }, '2026-11-09');
    expect(InvoiceSettlementSchema.parse(row)).toMatchObject({
      allocatedAmount: '0.00',
      openAmount: '1000.00',
      daysOverdue: 0,
      settlement: 'unpaid',
    });
  });

  it('is partly paid, then paid, as payments are allocated', () => {
    expect(
      settlementRow({ ...invoice, allocated: '300', credited: '0' }, '2026-11-09'),
    ).toMatchObject({ allocatedAmount: '300.00', openAmount: '700.00', settlement: 'partly_paid' });
    expect(
      settlementRow({ ...invoice, allocated: '1000', credited: '0' }, '2026-11-09'),
    ).toMatchObject({ openAmount: '0.00', settlement: 'paid' });
  });

  it('separates credit-note settlement from payments', () => {
    const row = settlementRow({ ...invoice, allocated: '400', credited: '400' }, '2026-11-09');
    expect(row).toMatchObject({
      allocatedAmount: '0.00',
      openAmount: '600.00',
      settlement: 'unpaid',
    });
    expect(
      settlementRow({ ...invoice, allocated: '1000', credited: '1000' }, '2026-11-09').settlement,
    ).toBe('credited');
  });

  it('is overdue after the due date and falls back to the issue date without one', () => {
    expect(
      settlementRow({ ...invoice, allocated: '0', credited: '0' }, '2026-12-05'),
    ).toMatchObject({ settlement: 'overdue', daysOverdue: 4 });
    expect(
      settlementRow({ ...invoice, dueDate: null, allocated: '0', credited: '0' }, '2026-11-03'),
    ).toMatchObject({ dueDate: null, settlement: 'overdue', daysOverdue: 2 });
  });
});

describe('agingReport', () => {
  const a = '00000000-0000-4000-8000-0000000000aa';
  const b = '00000000-0000-4000-8000-0000000000bb';

  it('buckets per customer and currency and totals per currency, never across currencies', () => {
    const report = agingReport(
      [
        {
          customerId: b,
          customerName: 'Beta',
          currency: 'NPR',
          openAmount: '100.00',
          dueDate: '2026-11-20',
        },
        {
          customerId: a,
          customerName: 'Acme',
          currency: 'NPR',
          openAmount: '250.50',
          dueDate: '2026-11-01',
        },
        {
          customerId: a,
          customerName: 'Acme',
          currency: 'NPR',
          openAmount: '49.50',
          dueDate: '2026-07-01',
        },
        {
          customerId: a,
          customerName: 'Acme',
          currency: 'USD',
          openAmount: '10.00',
          dueDate: '2026-09-30',
        },
      ],
      '2026-11-09',
    );
    expect(ArAgingReportSchema.parse(report)).toEqual({
      asOf: '2026-11-09',
      rows: [
        {
          customerId: a,
          customerName: 'Acme',
          currency: 'NPR',
          buckets: {
            current: '0.00',
            d1_30: '250.50',
            d31_60: '0.00',
            d61_90: '0.00',
            d91_plus: '49.50',
          },
          totalOpen: '300.00',
          promiseMissed: false,
          promiseMissedOn: null,
        },
        {
          customerId: a,
          customerName: 'Acme',
          currency: 'USD',
          buckets: {
            current: '0.00',
            d1_30: '0.00',
            d31_60: '10.00',
            d61_90: '0.00',
            d91_plus: '0.00',
          },
          totalOpen: '10.00',
          promiseMissed: false,
          promiseMissedOn: null,
        },
        {
          customerId: b,
          customerName: 'Beta',
          currency: 'NPR',
          buckets: {
            current: '100.00',
            d1_30: '0.00',
            d31_60: '0.00',
            d61_90: '0.00',
            d91_plus: '0.00',
          },
          totalOpen: '100.00',
          promiseMissed: false,
          promiseMissedOn: null,
        },
      ],
      totals: [
        {
          currency: 'NPR',
          buckets: {
            current: '100.00',
            d1_30: '250.50',
            d31_60: '0.00',
            d61_90: '0.00',
            d91_plus: '49.50',
          },
          totalOpen: '400.00',
        },
        {
          currency: 'USD',
          buckets: {
            current: '0.00',
            d1_30: '0.00',
            d31_60: '10.00',
            d61_90: '0.00',
            d91_plus: '0.00',
          },
          totalOpen: '10.00',
        },
      ],
    });
  });

  it('flags a row with a missed promise to pay and leaves the others alone (F1-Q33)', () => {
    const item = (customerId: string, currency: 'NPR' | 'USD') => ({
      customerId,
      customerName: customerId === a ? 'Acme' : 'Beta',
      currency,
      openAmount: '10.00',
      dueDate: '2026-11-01',
    });
    const report = agingReport(
      [item(a, 'NPR'), item(a, 'USD'), item(b, 'NPR')],
      '2026-11-09',
      // Beta's USD key has no open item, so it adds no row of its own.
      new Map([
        [agingRowKey(a, 'USD'), '2026-11-05'],
        [agingRowKey(b, 'USD'), '2026-11-06'],
      ]),
    );
    expect(
      ArAgingReportSchema.parse(report).rows.map((r) => [
        r.customerName,
        r.currency,
        r.promiseMissed,
        r.promiseMissedOn,
      ]),
    ).toEqual([
      ['Acme', 'NPR', false, null],
      ['Acme', 'USD', true, '2026-11-05'],
      ['Beta', 'NPR', false, null],
    ]);
  });

  it('is empty with nothing open', () => {
    expect(agingReport([], '2026-11-09')).toEqual({ asOf: '2026-11-09', rows: [], totals: [] });
  });
});
