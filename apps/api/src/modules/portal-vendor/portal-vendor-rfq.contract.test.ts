// Contract test of the vendor portal's RFQ DTOs (P4 unit PV3). Serves the NFR "a vendor sees only what we meant to
// show": the key set of each RFQ view is pinned at every depth, so a schema that gains a key fails here and the change
// has to be looked at on purpose; the mappers build exactly those keys from rows full of internal columns (estimates,
// budget code, rationale, other vendors); and no key names an internal field (forbiddenPortalKeys).
import {
  forbiddenPortalKeys,
  VendorPortalRfqListItemSchema,
  VendorPortalRfqViewSchema,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  type RfqLineSource,
  type RfqSource,
  toRfqListItem,
  toRfqView,
} from './portal-vendor-rfq.views';

/** Every key path of a schema: objects by key, arrays as `[]`, nullable and optional unwrapped. */
function keyPaths(schema: z.ZodType, prefix = ''): string[] {
  if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) {
    return keyPaths(schema.unwrap() as z.ZodType, prefix);
  }
  if (schema instanceof z.ZodArray) return keyPaths(schema.element as z.ZodType, `${prefix}[].`);
  if (schema instanceof z.ZodObject) {
    return Object.entries(schema.shape as Record<string, z.ZodType>).flatMap(([k, v]) => [
      `${prefix}${k}`,
      ...keyPaths(v, `${prefix}${k}.`),
    ]);
  }
  return [];
}

/** Every key path of a value, the same notation. */
function valuePaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) {
    return [...new Set(value.flatMap((v) => valuePaths(v, `${prefix}[].`)))];
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [
      `${prefix}${k}`,
      ...valuePaths(v, `${prefix}${k}.`),
    ]);
  }
  return [];
}

const sorted = (xs: string[]) => [...xs].sort();

const RFQ_LIST_KEYS = ['deadline', 'id', 'number'];
const RFQ_VIEW_KEYS = [
  'deadline',
  'id',
  'lines',
  'lines.[].description',
  'lines.[].lineNo',
  'lines.[].quantity',
  'lines.[].uom',
  'number',
];

const RFQ_ID = '00000000-0000-4000-8000-0000000000d1';

/** An RFQ row as an unwary reader would load it: the extra columns must not reach the view. */
const rfq = {
  id: RFQ_ID,
  number: 'RFQ-1',
  deadline: new Date('2026-11-20T11:00:00Z'),
  status: 'open',
  purchaseRequestId: '00000000-0000-4000-8000-0000000000d2',
  recommendedQuotationId: null,
  fewerThanThreeReason: 'Only two vendors supply this',
  recommendationRationale: 'Lowest landed cost',
  commitmentApprovalRequestId: null,
  createdBy: '00000000-0000-4000-8000-0000000000d3',
} as unknown as RfqSource;

const prLines = [
  {
    lineNo: 2,
    description: 'Cable',
    uom: 'm',
    quantity: '50.0000',
    estimatedUnitPrice: '90.00',
    estimatedAmount: '4500.00',
    specification: 'Cat6, budget code IT-2083',
  },
  {
    lineNo: 1,
    description: 'Switch',
    uom: 'pcs',
    quantity: '2.0000',
    estimatedUnitPrice: '1500.50',
    estimatedAmount: '3001.00',
    specification: null,
  },
] as unknown as RfqLineSource[];

describe('vendor portal RFQ DTO key sets (a new key fails here)', () => {
  it('pins the RFQ list item', () => {
    expect(sorted(keyPaths(VendorPortalRfqListItemSchema))).toEqual(RFQ_LIST_KEYS);
  });
  it('pins the RFQ view', () => {
    expect(sorted(keyPaths(VendorPortalRfqViewSchema))).toEqual(RFQ_VIEW_KEYS);
  });
  it('names no internal field in any pinned key', () => {
    for (const keys of [RFQ_LIST_KEYS, RFQ_VIEW_KEYS]) {
      const asObject = Object.fromEntries(keys.map((k) => [k.split('.').pop() ?? k, 1]));
      expect(forbiddenPortalKeys(asObject)).toEqual([]);
    }
  });
  it('refuses a view with an extra key', () => {
    const item = toRfqListItem(rfq);
    expect(() => VendorPortalRfqListItemSchema.parse({ ...item, estimatedTotal: '1.00' })).toThrow();
    const view = toRfqView(rfq, prLines);
    expect(() => VendorPortalRfqViewSchema.parse({ ...view, vendorIds: [] })).toThrow();
    expect(() =>
      VendorPortalRfqViewSchema.parse({
        ...view,
        lines: [{ ...view.lines[0], estimatedUnitPrice: '1.00' }],
      }),
    ).toThrow();
  });
});

describe('vendor portal RFQ mappers', () => {
  it('builds the list item with exactly the pinned keys from a row full of internal columns', () => {
    const item = toRfqListItem(rfq);
    expect(sorted(valuePaths(item))).toEqual(RFQ_LIST_KEYS);
    // The deadline is the exact instant, so a vendor knows the hour as well as the day.
    expect(item).toEqual({ id: RFQ_ID, number: 'RFQ-1', deadline: '2026-11-20T11:00:00.000Z' });
  });

  it('builds the view with exactly the pinned keys, lines in line order, without estimates', () => {
    const view = toRfqView(rfq, prLines);
    expect(sorted(valuePaths(view))).toEqual(RFQ_VIEW_KEYS);
    expect(forbiddenPortalKeys(view)).toEqual([]);
    expect(view.lines).toEqual([
      { lineNo: 1, description: 'Switch', uom: 'pcs', quantity: '2.0000' },
      { lineNo: 2, description: 'Cable', uom: 'm', quantity: '50.0000' },
    ]);
    expect(JSON.stringify(view)).not.toMatch(/1500|4500|IT-2083|Lowest|Only two/);
  });
});
