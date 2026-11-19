// The list and summary routes of PaymentsController: query parsing (repeated filters, unknown values), the total
// header and the route order. The SQL is covered by payments.integration.test.ts.
import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { CAN_KEY } from '../../platform/authz/decorators';
import { PaymentsController } from './payments.controller';

const SCOPE = { tenantId: 't', organizationId: 'o' };

function setup() {
  const payments = {
    list: vi.fn().mockResolvedValue({ rows: [], total: 0 }),
    summary: vi.fn().mockResolvedValue({ total: 0, byStatus: {} }),
  };
  const caller = { current: () => ({ scope: SCOPE, actor: {} }) };
  const controller = new PaymentsController(payments as never, caller as never);
  const res = { setHeader: vi.fn() };
  const list = (query: unknown) => controller.list(query, res as unknown as Response);
  return { payments, controller, res, list };
}

describe('GET /v1/payments query', () => {
  it('reads repeated status and method as arrays, dedupes them and keeps no limit as no limit', async () => {
    const { payments, list } = setup();
    await list({ status: ['submitted', 'verified', 'verified'], method: 'cash', q: ' rcpt ' });
    expect(payments.list).toHaveBeenCalledWith(SCOPE, {
      status: ['submitted', 'verified'],
      method: ['cash'],
      q: 'rcpt',
      offset: 0,
    });
  });

  it('answers a bare array with the total of all matches in X-Total-Count', async () => {
    const { payments, res, list } = setup();
    payments.list.mockResolvedValue({ rows: [{ id: 'a' }], total: 7 });
    await expect(list({ limit: '5', offset: '5' })).resolves.toEqual([{ id: 'a' }]);
    expect(payments.list).toHaveBeenCalledWith(SCOPE, { limit: 5, offset: 5 });
    expect(res.setHeader).toHaveBeenCalledWith('X-Total-Count', '7');
  });

  it.each([
    { status: 'paid' },
    { status: ['verified', 'nope'] },
    { method: 'card' },
    { x: '1' },
    { q: ['ab', 'cd'] },
    { limit: '101' },
    { offset: '-1' },
  ])('answers 400 to %j', async (query) => {
    const { payments, list } = setup();
    await expect(list(query)).rejects.toThrow(BadRequestException);
    expect(payments.list).not.toHaveBeenCalled();
  });
});

describe('GET /v1/payments/summary', () => {
  it('passes q and method and refuses status and paging', () => {
    const { payments, controller } = setup();
    void controller.summary({ q: 'rcpt', method: ['cash', 'qr'] });
    expect(payments.summary).toHaveBeenCalledWith(SCOPE, { q: 'rcpt', method: ['cash', 'qr'] });
    for (const query of [{ status: 'verified' }, { limit: '5' }]) {
      expect(() => controller.summary(query), JSON.stringify(query)).toThrow(BadRequestException);
    }
    expect(payments.summary).toHaveBeenCalledTimes(1);
  });

  it('is declared before /:id, so the word is not read as a payment id, and needs payment.read', () => {
    const names = Object.getOwnPropertyNames(PaymentsController.prototype);
    expect(names.indexOf('summary')).toBeLessThan(names.indexOf('get'));
    expect(Reflect.getMetadata(CAN_KEY, PaymentsController.prototype.summary)).toBe('payment.read');
  });
});
