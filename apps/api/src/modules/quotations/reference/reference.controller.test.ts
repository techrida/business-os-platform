// Unit tests of the reference routes without a database: both are bare-array GETs (payment-terms behind
// quotation.read, tax-codes behind a service any-of check), the route sweep finds no unmarked route, and the pure
// mapping from a tax_codes row to TaxCodeSchema is exact (rate is percent as text, rateBp the basis points, the day
// is Kathmandu's, not UTC's).
import 'reflect-metadata';

import { PaymentTermSchema, TaxCodeSchema } from '@bos/contracts';
import { Test } from '@nestjs/testing';
import { describe, expect, it, vi } from 'vitest';

import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../../../platform/authz/decorators';
import { findUnmarkedRoutes } from '../../../platform/authz/route-policy.check';
import { ReferenceController } from './reference.controller';
import { ReferenceService } from './reference.service';
import { kathmanduDay, percentText, toPaymentTermDto, toTaxCodeDto } from './reference.types';

const ID = '4f6c7a5e-0d52-4d1e-9d8a-3f1d2c3b4a5f';

async function setup() {
  const service = {
    listTaxCodes: vi.fn().mockResolvedValue([]),
    listPaymentTerms: vi.fn().mockResolvedValue([]),
    listWithholdingCodes: vi.fn().mockResolvedValue([]),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [ReferenceController],
    providers: [{ provide: ReferenceService, useValue: service }],
  }).compile();
  return { service, moduleRef, controller: moduleRef.get(ReferenceController) };
}

describe('ReferenceController', () => {
  it('guards payment-terms with quotation.read, leaves tax-codes to the service any-of check, and leaves none unmarked', async () => {
    const { moduleRef } = await setup();
    expect(findUnmarkedRoutes(moduleRef)).toEqual([]);
    expect(Reflect.getMetadata(CAN_KEY, ReferenceController.prototype.withholdingCodes)).toBe(
      'payables.bill.enter',
    );
    expect(Reflect.getMetadata(CAN_KEY, ReferenceController.prototype.paymentTerms)).toBe(
      'quotation.read',
    );
    // Three permissions may read the tax codes and one @Can names one, so the grant is checked in ReferenceService.
    expect(Reflect.getMetadata(CAN_KEY, ReferenceController.prototype.taxCodes)).toBeUndefined();
    expect(Reflect.getMetadata(ANY_AUTHENTICATED_KEY, ReferenceController.prototype.taxCodes)).toBe(
      true,
    );
    await moduleRef.close();
  });

  it('returns the service list as the bare array', async () => {
    const { service, controller } = await setup();
    const tax = [{ id: ID, label: 'VAT 13%' }];
    const terms = [{ id: ID, label: 'Net 30' }];
    service.listTaxCodes.mockResolvedValue(tax);
    service.listPaymentTerms.mockResolvedValue(terms);
    await expect(controller.taxCodes()).resolves.toBe(tax);
    await expect(controller.paymentTerms()).resolves.toBe(terms);
    const withholding = [{ id: ID, code: 'TDS0', name: 'Pending signoff', rateBp: 0 }];
    service.listWithholdingCodes.mockResolvedValue(withholding);
    await expect(controller.withholdingCodes()).resolves.toBe(withholding);
  });
});

describe('reference mapping', () => {
  it('writes basis points as percent text without losing a digit', () => {
    expect(percentText(1300)).toBe('13');
    expect(percentText(0)).toBe('0');
    expect(percentText(650)).toBe('6.5');
    expect(percentText(1)).toBe('0.01');
    expect(percentText(1234)).toBe('12.34');
    expect(percentText(10000)).toBe('100');
  });

  it('maps a tax_codes row to TaxCodeSchema', () => {
    const dto = toTaxCodeDto({
      id: ID,
      code: 'VAT13',
      name: 'VAT 13%',
      kind: 'vat',
      rateBp: 1300,
      creditable: true,
      effectiveFrom: '2026-01-01',
      effectiveTo: null,
    });
    expect(dto).toEqual({
      id: ID,
      label: 'VAT 13%',
      rate: '13',
      code: 'VAT13',
      kind: 'vat',
      rateBp: 1300,
    });
    expect(TaxCodeSchema.parse(dto)).toEqual(dto);
  });

  it('maps a payment term to {id, label}', () => {
    const dto = toPaymentTermDto({ id: ID, name: 'Net 30' });
    expect(dto).toEqual({ id: ID, label: 'Net 30' });
    expect(PaymentTermSchema.parse(dto)).toEqual(dto);
  });

  it('takes the calendar day in Asia/Kathmandu: 19:00 UTC is already tomorrow there', () => {
    expect(kathmanduDay(new Date('2026-03-09T19:00:00Z'))).toBe('2026-03-10');
    expect(kathmanduDay(new Date('2026-03-09T18:14:59Z'))).toBe('2026-03-09');
    expect(kathmanduDay(new Date('2026-12-31T18:15:00Z'))).toBe('2027-01-01');
  });
});
