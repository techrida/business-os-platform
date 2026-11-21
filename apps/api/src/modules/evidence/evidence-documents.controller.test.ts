// The evidence upload routes name their record kind's own permission at route level (round 5 P2), so the route sweep
// and the tenancy interceptor refuse a caller without it before any service code runs; the service and the
// documents kernel then check that grant on the record itself.
// Run: pnpm --filter @bos/api exec vitest run src/modules/evidence/evidence-documents.controller.test.ts
import 'reflect-metadata';

import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';

import { CAN_KEY } from '../../platform/authz/decorators';
import { EvidenceDocumentsController } from './evidence-documents.controller';

const routes: [keyof EvidenceDocumentsController, string, string][] = [
  ['createForSalesOrder', 'sales-orders/:id/evidence-documents', 'sales_order.mark_billable'],
  [
    'uploadForSalesOrder',
    'sales-orders/:id/evidence-documents/:docId/versions/:verId/content',
    'sales_order.mark_billable',
  ],
  ['createForBill', 'payables/bills/:id/evidence-documents', 'payables.bill.enter'],
  [
    'uploadForBill',
    'payables/bills/:id/evidence-documents/:docId/versions/:verId/content',
    'payables.bill.enter',
  ],
  ['createForRfq', 'procurement/rfqs/:id/evidence-documents', 'procurement.sourcing'],
  [
    'uploadForRfq',
    'procurement/rfqs/:id/evidence-documents/:docId/versions/:verId/content',
    'procurement.sourcing',
  ],
];

describe('EvidenceDocumentsController', () => {
  it.each(routes)('%s is %s under @Can(%s)', (method, path, permission) => {
    const handler = EvidenceDocumentsController.prototype[method];
    expect(Reflect.getMetadata(PATH_METADATA, EvidenceDocumentsController)).toBe('v1');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
    expect(Reflect.getMetadata(CAN_KEY, handler)).toBe(permission);
  });
});
