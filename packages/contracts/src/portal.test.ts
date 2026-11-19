import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  AcceptQuotationBodySchema,
  CUSTOMER_VIEW_FORBIDDEN_WORDS,
  CUSTOMER_VISIBLE_STATUSES,
  CustomerQuotationViewSchema,
  PortalQuotationListItemSchema,
  QUOTATION_STATUSES,
  QuotationVersionDtoSchema,
  RejectQuotationBodySchema,
  isCustomerVisibleStatus,
} from './index.js';

const id = () => crypto.randomUUID();
const address = { line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' };

const view = () => ({
  id: id(),
  number: 'QT-2082-0042',
  revisionNo: 2,
  status: 'sent',
  issueDate: '2026-11-08',
  validUntil: '2026-11-23',
  currency: 'USD',
  issuer: { legalName: 'Techrida Pvt. Ltd.', panVatNo: '301234567', address },
  customer: { legalName: 'Himal Traders Pvt. Ltd.', panVatNo: null, address },
  contact: { fullName: 'Sita Rai', email: 'sita@himal.example' },
  scope: 'Supply and install 12 panels',
  assumptions: null,
  exclusions: null,
  termsAndConditions: null,
  deliveryTimeline: '6 weeks',
  paymentTermName: 'Net 30',
  paymentSchedule: [{ label: 'Advance', percent: '60', amount: '366120.00' }],
  lines: [
    {
      lineNo: 1,
      description: 'Solar panel 550W',
      uom: 'pcs',
      quantity: '12',
      unitPrice: '45000.00',
      amount: '540000.00',
    },
  ],
  totals: {
    subtotal: '540000.00',
    discountAmount: '0.00',
    taxableAmount: '540000.00',
    taxAmount: '70200.00',
    total: '610200.00',
  },
  taxSummary: [{ label: 'VAT', percent: '13', base: '540000.00', tax: '70200.00' }],
  file: { documentId: id(), filename: 'QT-2082-0042-R2.pdf', sha256: 'a'.repeat(64) },
});

/** Words that make a key internal. Keys are split into words, so "generatedAt" does not trip "rate". */
const words = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Every property name in a schema, at any depth: objects, array items, optional and nullable
 * wrappers, unions. Read from the JSON Schema of the schema itself, so an optional field that a
 * sample leaves out is still found.
 */
function schemaKeys(schema: z.ZodType): string[] {
  const keys: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (node === null || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'properties' && v !== null && typeof v === 'object') {
        keys.push(...Object.keys(v));
      }
      walk(v);
    }
  };
  walk(z.toJSONSchema(schema, { io: 'output' }));
  return keys;
}

const leaks = (keys: string[]) =>
  keys.filter((k) => words(k).some((w) => CUSTOMER_VIEW_FORBIDDEN_WORDS.includes(w)));

describe('CustomerQuotationView carries no cost, margin or rate', () => {
  it('has no such key anywhere in its schema, at any depth', () => {
    const keys = schemaKeys(CustomerQuotationViewSchema);
    expect(keys).toContain('lines');
    expect(keys).toContain('unitPrice');
    expect(keys).toContain('percent');
    expect(leaks(keys)).toEqual([]);
  });

  it('proves the walker works: it finds a cost key hidden in an optional nullable array item', () => {
    const planted = z.object({
      lines: z.array(
        z.object({
          ok: z.string(),
          inner: z.object({ unitCost: z.string() }).nullable().optional(),
        }),
      ),
    });
    expect(leaks(schemaKeys(planted))).toEqual(['unitCost']);
    expect(leaks(['marginPct', 'nprRate', 'rateSource', 'internalCostTotal'])).toHaveLength(4);
    expect(leaks(['generatedAt', 'separate', 'percent', 'unitPrice'])).toEqual([]);
  });

  it('forbids the words cost, margin, rate and the NPR equivalent', () => {
    for (const w of ['cost', 'margin', 'rate', 'npr']) {
      expect(CUSTOMER_VIEW_FORBIDDEN_WORDS).toContain(w);
    }
  });

  it('parses a customer view', () => {
    expect(CustomerQuotationViewSchema.safeParse(view()).success).toBe(true);
  });

  it('is strict: a stray cost, margin or rate key is refused, never passed through', () => {
    const v = view();
    expect(CustomerQuotationViewSchema.safeParse({ ...v, marginPct: '12.5000' }).success).toBe(
      false,
    );
    expect(CustomerQuotationViewSchema.safeParse({ ...v, internalCostTotal: '1.00' }).success).toBe(
      false,
    );
    expect(
      CustomerQuotationViewSchema.safeParse({
        ...v,
        nprSnapshot: { amountNpr: '1.00', rate: '133.5', rateSource: 'x', rateDate: '2026-11-08' },
      }).success,
    ).toBe(false);
    expect(
      CustomerQuotationViewSchema.safeParse({
        ...v,
        lines: [{ ...v.lines[0], unitCost: '30000.00' }],
      }).success,
    ).toBe(false);
    expect(
      CustomerQuotationViewSchema.safeParse({
        ...v,
        taxSummary: [{ ...v.taxSummary[0], rate: '13.0000' }],
      }).success,
    ).toBe(false);
  });

  it('refuses a whole internal version: the renderer cannot be handed one by mistake', () => {
    const internal = QuotationVersionDtoSchema.shape;
    expect(Object.keys(internal)).toContain('marginPct');
    const asView = {
      ...view(),
      marginPct: null,
      internalCostTotal: null,
      nprSnapshot: null,
      approvalRequestId: null,
    };
    expect(CustomerQuotationViewSchema.safeParse(asView).success).toBe(false);
  });

  it('keeps money as strings', () => {
    const v = view();
    expect(
      CustomerQuotationViewSchema.safeParse({ ...v, totals: { ...v.totals, total: 610200 } })
        .success,
    ).toBe(false);
    expect(
      CustomerQuotationViewSchema.safeParse({ ...v, lines: [{ ...v.lines[0], quantity: 12 }] })
        .success,
    ).toBe(false);
  });

  it('shows the customer only the states they can see', () => {
    expect([...CUSTOMER_VISIBLE_STATUSES].sort()).toEqual([
      'accepted',
      'expired',
      'rejected',
      'sent',
      'superseded',
    ]);
    for (const s of ['draft', 'submitted', 'returned', 'approved', 'cancelled'] as const) {
      expect(isCustomerVisibleStatus(s), s).toBe(false);
      expect(CustomerQuotationViewSchema.safeParse({ ...view(), status: s }).success, s).toBe(
        false,
      );
    }
    for (const s of QUOTATION_STATUSES.filter(isCustomerVisibleStatus)) {
      expect(CustomerQuotationViewSchema.safeParse({ ...view(), status: s }).success, s).toBe(true);
    }
  });

  it('names the file by hash so the customer can check a download', () => {
    const v = view();
    expect(CustomerQuotationViewSchema.safeParse({ ...v, file: null }).success).toBe(true);
    expect(
      CustomerQuotationViewSchema.safeParse({ ...v, file: { ...v.file, sha256: 'xyz' } }).success,
    ).toBe(false);
  });
});

describe('PortalQuotationListItemSchema', () => {
  const item = {
    id: id(),
    number: 'QT-2082-0042',
    revisionNo: 1,
    status: 'sent',
    issueDate: '2026-11-08',
    validUntil: '2026-11-23',
    currency: 'NPR',
    total: '610200.00',
  };

  it('parses a list row and keeps its keys clean', () => {
    expect(PortalQuotationListItemSchema.safeParse(item).success).toBe(true);
    expect(leaks(schemaKeys(PortalQuotationListItemSchema))).toEqual([]);
  });

  it('refuses a draft status and a stray key', () => {
    expect(PortalQuotationListItemSchema.safeParse({ ...item, status: 'draft' }).success).toBe(
      false,
    );
    expect(PortalQuotationListItemSchema.safeParse({ ...item, marginPct: '1' }).success).toBe(
      false,
    );
  });
});

describe('AcceptQuotationBodySchema', () => {
  it('trims the typed name and needs the ticked box', () => {
    expect(
      AcceptQuotationBodySchema.safeParse({ acceptedByName: ' Jules ', confirm: true }).data,
    ).toEqual({ acceptedByName: 'Jules', confirm: true });
    expect(
      AcceptQuotationBodySchema.safeParse({ acceptedByName: 'Jules', confirm: false }).success,
    ).toBe(false);
    expect(AcceptQuotationBodySchema.safeParse({ acceptedByName: 'Jules' }).success).toBe(false);
  });

  it('refuses a blank or oversized name and any extra key', () => {
    expect(
      AcceptQuotationBodySchema.safeParse({ acceptedByName: '   ', confirm: true }).success,
    ).toBe(false);
    expect(
      AcceptQuotationBodySchema.safeParse({ acceptedByName: 'x'.repeat(201), confirm: true })
        .success,
    ).toBe(false);
    expect(
      AcceptQuotationBodySchema.safeParse({ acceptedByName: 'J', confirm: true, evidenceKind: 'x' })
        .success,
    ).toBe(false);
  });
});

describe('RejectQuotationBodySchema', () => {
  it('trims the comment and refuses a blank, oversized or extra-key body', () => {
    expect(RejectQuotationBodySchema.safeParse({ comment: ' too dear ' }).data).toEqual({
      comment: 'too dear',
    });
    expect(RejectQuotationBodySchema.safeParse({ comment: '  ' }).success).toBe(false);
    expect(RejectQuotationBodySchema.safeParse({ comment: 'x'.repeat(2001) }).success).toBe(false);
    expect(RejectQuotationBodySchema.safeParse({ comment: 'no', status: 'accepted' }).success).toBe(
      false,
    );
  });
});
