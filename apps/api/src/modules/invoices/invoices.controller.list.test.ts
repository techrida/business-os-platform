// The list and summary routes of InvoicesController: query parsing (repeated filters, unknown values, bad
// ranges), the total header and the route order. The SQL is covered by invoice-drafting.integration.test.ts.
import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../platform/authz/decorators';
import { InvoicesController } from './invoices.controller';

const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';

function setup() {
  const drafting = {
    list: vi.fn().mockResolvedValue({ rows: [], total: 0, totals: [] }),
    summary: vi.fn().mockResolvedValue({ total: 0, byStatus: {}, customers: [] }),
  };
  const controller = new InvoicesController(
    drafting as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const res = { setHeader: vi.fn() };
  const list = (query: unknown) => controller.list(query, res as unknown as Response);
  return { drafting, controller, res, list };
}

describe('GET /v1/invoices query', () => {
  it('reads repeated filters as arrays, dedupes them and keeps no limit as no limit', async () => {
    const { drafting, list } = setup();
    await list({
      kind: ['tax_invoice', 'proforma', 'proforma'],
      status: 'issued',
      settlement: ['paid', 'overdue'],
      customerId: [CUSTOMER, OTHER],
      issuedFrom: '2026-11-01',
      issuedTo: '2026-11-30',
      q: ' acme ',
    });
    expect(drafting.list).toHaveBeenCalledWith({
      kind: ['tax_invoice', 'proforma'],
      status: ['issued'],
      settlement: ['paid', 'overdue'],
      customerId: [CUSTOMER, OTHER],
      issuedFrom: '2026-11-01',
      issuedTo: '2026-11-30',
      q: 'acme',
      offset: 0,
    });
  });

  it('answers a bare array with the total of all matches in X-Total-Count', async () => {
    const { drafting, res, list } = setup();
    drafting.list.mockResolvedValue({
      rows: [{ id: 'a' }],
      total: 41,
      totals: [
        { currency: 'NPR', amount: '2018180.00' },
        { currency: 'USD', amount: '25.00' },
      ],
    });
    await expect(list({ limit: '10', offset: '30' })).resolves.toEqual([{ id: 'a' }]);
    expect(drafting.list).toHaveBeenCalledWith({ limit: 10, offset: 30 });
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '41');
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Money-Totals',
      '[{"currency":"NPR","amount":"2018180.00"},{"currency":"USD","amount":"25.00"}]',
    );
  });

  it('treats a one-character q as no search', async () => {
    const { drafting, list } = setup();
    await list({ q: 'a' });
    expect(drafting.list).toHaveBeenCalledWith({ offset: 0 });
  });

  it.each([
    { status: 'paid' },
    { status: ['issued', 'nope'] },
    { kind: 'receipt' },
    { settlement: 'late' },
    { customerId: 'nope' },
    { issuedFrom: '2026-13-01' },
    { issuedFrom: '2026-12-01', issuedTo: '2026-11-01' },
    { x: '1' },
    { q: ['ab', 'cd'] },
    { limit: '0' },
    { limit: '101' },
    { offset: '-1' },
    { status: Array.from({ length: 21 }, () => 'draft') },
  ])('answers 400 to %j', async (query) => {
    const { drafting, list } = setup();
    await expect(list(query)).rejects.toThrow(BadRequestException);
    expect(drafting.list).not.toHaveBeenCalled();
  });
});

describe('GET /v1/invoices/summary', () => {
  it('passes the filters and refuses status, settlement and paging', () => {
    const { drafting, controller } = setup();
    void controller.summary({ q: 'acme', kind: 'proforma', customerId: [CUSTOMER] });
    expect(drafting.summary).toHaveBeenCalledWith({
      q: 'acme',
      kind: ['proforma'],
      customerId: [CUSTOMER],
    });
    for (const query of [{ status: 'draft' }, { settlement: 'paid' }, { limit: '5' }]) {
      expect(() => controller.summary(query), JSON.stringify(query)).toThrow(BadRequestException);
    }
    expect(drafting.summary).toHaveBeenCalledTimes(1);
  });

  it('is declared before /:id, so the word is not read as an invoice id, and needs invoice.read', () => {
    const names = Object.getOwnPropertyNames(InvoicesController.prototype);
    expect(names.indexOf('summary')).toBeLessThan(names.indexOf('detail'));
    expect(Reflect.getMetadata(CAN_KEY, InvoicesController.prototype.summary)).toBe('invoice.read');
  });
});
