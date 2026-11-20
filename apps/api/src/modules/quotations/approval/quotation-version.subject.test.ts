// Unit tests of the quotation_version approval subject (Q2 part 3). The database is a fake transaction whose
// selects answer by table and whose update and insert record what was written; the trigger guards, the CHECKs and
// the hash of rows read back from Postgres belong to the quotations integration test.
import {
  quotationLines,
  quotationStatusHistory,
  quotationTaxSummary,
  quotationVersions,
} from '@bos/db';
import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { DbTransaction } from '../../../platform/db/db.module';
import type { PricedLineRow, TaxSummaryRow } from '../pricing/pricing.types';
import { contentSha256, materialFieldsOf } from './quotation-approval-snapshot';
import {
  QUOTATION_VERSION_DOCUMENT_TYPE,
  QuotationVersionSubject,
  quotationLinkOf,
} from './quotation-version.subject';

type VersionRow = typeof quotationVersions.$inferSelect;

const TENANT = '22222222-2222-4222-8222-222222222222';
const ENTITY = '33333333-3333-4333-8333-333333333333';
const VERSION_ID = '11111111-1111-4111-8111-111111111111';
const QUOTATION_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-11-09T10:00:00Z');

const LINES: PricedLineRow[] = [
  {
    lineNo: 1,
    catalogItemId: null,
    description: 'Audit',
    uom: 'job',
    quantity: '1.0000',
    unitPrice: '100.00',
    unitCost: null,
    taxCodeId: 'tc-vat',
    gross: '100.00',
    discountAlloc: '0.00',
    taxable: '100.00',
  },
];
const TAX: TaxSummaryRow[] = [
  { taxCodeId: 'tc-vat', label: 'VAT 13%', rate: '13.0000', base: '100.00', tax: '13.00' },
];

/** A submitted version whose stored content hash matches LINES and TAX. */
function submittedRow(extra: Partial<VersionRow> = {}): VersionRow {
  const row: VersionRow = {
    id: VERSION_ID,
    tenantId: TENANT,
    organizationId: ENTITY,
    quotationId: QUOTATION_ID,
    revisionNo: 1,
    status: 'submitted',
    rejectionSource: null,
    contactId: null,
    templateId: null,
    currency: 'NPR',
    issueDate: '2026-11-09',
    validUntil: '2026-12-09',
    scope: 'Supply and install',
    assumptions: null,
    exclusions: null,
    termsAndConditions: null,
    deliveryTimeline: null,
    paymentTermId: null,
    paymentSchedule: [],
    discountMode: null,
    discountInput: null,
    subtotal: '100.00',
    discountAmount: '0.00',
    taxableAmount: '100.00',
    taxAmount: '13.00',
    total: '113.00',
    effectiveDiscountPct: '0.0000',
    fxRate: '1.000000',
    fxSource: null,
    fxDate: null,
    amountNpr: '113.00',
    nprTaxableAmount: '100.00',
    internalCostTotal: null,
    marginPct: null,
    calcVersion: 1,
    contentSha256: null,
    snapshotSha256: Buffer.alloc(32, 1),
    approvalRequestId: null,
    renderedDocumentId: null,
    renderedSha256: null,
    renderState: 'none',
    documentStyle: null,
    renderAttempts: 0,
    supersedesVersionId: null,
    supersededByVersionId: null,
    revisionReason: null,
    cancelReason: null,
    submittedAt: new Date('2026-11-09T09:00:00Z'),
    approvedAt: null,
    sentAt: null,
    acceptedAt: null,
    rejectedAt: null,
    expiredAt: null,
    cancelledAt: null,
    version: 2,
    createdAt: new Date('2026-11-09T00:00:00Z'),
    updatedAt: new Date('2026-11-09T09:00:00Z'),
    ...extra,
  };
  if (!('contentSha256' in extra)) {
    row.contentSha256 = contentSha256(materialFieldsOf(row, LINES, TAX));
  }
  return row;
}

interface Written {
  updates: Record<string, unknown>[];
  inserts: { table: string; values: Record<string, unknown> }[];
  locked: boolean;
}

/** A transaction whose selects answer by table; update and insert record their values. */
function fakeTx(tables: {
  versions: VersionRow[];
  lines?: PricedLineRow[];
  tax?: TaxSummaryRow[];
}) {
  const written: Written = { updates: [], inserts: [], locked: false };
  const rowsOf = (table: unknown): unknown[] =>
    table === quotationVersions
      ? tables.versions
      : table === quotationLines
        ? (tables.lines ?? LINES)
        : table === quotationTaxSummary
          ? (tables.tax ?? TAX)
          : [];
  const thenable = (rows: unknown[]) => ({
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  });
  const tx = {
    execute: () =>
      Promise.resolve({
        rows: [{ tenant_id: TENANT, organization_id: ENTITY, actor_id: ACTOR, actor_kind: 'user' }],
      }),
    select: () => ({
      from: (table: unknown) => {
        const rows = rowsOf(table);
        const chain = {
          where: () => chain,
          orderBy: () => chain,
          limit: () => rows,
          for: () => {
            written.locked = true;
            return thenable(rows);
          },
          then: thenable(rows).then,
        };
        return chain;
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => ({
          returning: () => {
            if (table === quotationVersions) written.updates.push(values);
            return Promise.resolve(tables.versions.map((v) => ({ id: v.id })));
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        written.inserts.push({
          table: table === quotationStatusHistory ? 'quotation_status_history' : 'unexpected',
          values,
        });
        return Promise.resolve();
      },
    }),
  };
  return { tx: tx as unknown as DbTransaction, written };
}

const subject = () => new QuotationVersionSubject(() => NOW);

describe('QuotationVersionSubject.onDecided', () => {
  it('is registered for quotation_version', () => {
    expect(subject().documentType).toBe('quotation_version');
    expect(QUOTATION_VERSION_DOCUMENT_TYPE).toBe('quotation_version');
  });

  it('approve locks the version, sets approved and approved_at, and writes the history row', async () => {
    const { tx, written } = fakeTx({ versions: [submittedRow()] });
    await subject().onDecided(tx, VERSION_ID, 'approved');
    expect(written.locked).toBe(true);
    expect(written.updates).toHaveLength(1);
    expect(written.updates[0]).toMatchObject({
      status: 'approved',
      approvedAt: NOW,
      updatedAt: NOW,
    });
    expect(written.updates[0]).not.toHaveProperty('rejectionSource');
    // Never rendered here (M3): render_state stays 'none' for the sweeper.
    expect(written.updates[0]).not.toHaveProperty('renderState');
    expect(written.inserts).toEqual([
      {
        table: 'quotation_status_history',
        values: {
          tenantId: TENANT,
          organizationId: ENTITY,
          versionId: VERSION_ID,
          fromStatus: 'submitted',
          toStatus: 'approved',
          actorId: ACTOR,
          at: NOW,
        },
      },
    ]);
  });

  it('return sets returned without a rejection source', async () => {
    const { tx, written } = fakeTx({ versions: [submittedRow()] });
    await subject().onDecided(tx, VERSION_ID, 'returned');
    expect(written.updates[0]).toMatchObject({ status: 'returned', updatedAt: NOW });
    expect(written.updates[0]).not.toHaveProperty('approvedAt');
    expect(written.updates[0]).not.toHaveProperty('rejectionSource');
    expect(written.inserts[0]?.values).toMatchObject({
      fromStatus: 'submitted',
      toStatus: 'returned',
    });
  });

  it('reject sets rejected with rejection_source internal', async () => {
    const { tx, written } = fakeTx({ versions: [submittedRow()] });
    await subject().onDecided(tx, VERSION_ID, 'rejected');
    expect(written.updates[0]).toMatchObject({
      status: 'rejected',
      rejectionSource: 'internal',
      rejectedAt: NOW,
    });
    expect(written.inserts[0]?.values).toMatchObject({
      fromStatus: 'submitted',
      toStatus: 'rejected',
    });
  });

  it('refuses with 409 when a material field no longer matches the stored hash (M10)', async () => {
    const tampered = [{ ...LINES[0]!, unitPrice: '99.00' }];
    const { tx, written } = fakeTx({ versions: [submittedRow()], lines: tampered });
    await expect(subject().onDecided(tx, VERSION_ID, 'approved')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(written.updates).toEqual([]);
    expect(written.inserts).toEqual([]);
  });

  it('refuses with 409 when a version column changed after the hash was stored', async () => {
    const stored = submittedRow().contentSha256;
    const { tx, written } = fakeTx({
      versions: [submittedRow({ scope: 'Supply only', contentSha256: stored })],
    });
    await expect(subject().onDecided(tx, VERSION_ID, 'approved')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(written.updates).toEqual([]);
  });

  it('refuses with 409 when no content hash is stored', async () => {
    const { tx } = fakeTx({ versions: [submittedRow({ contentSha256: null })] });
    await expect(subject().onDecided(tx, VERSION_ID, 'approved')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses with 409 when the version is not submitted', async () => {
    const { tx, written } = fakeTx({ versions: [submittedRow({ status: 'approved' })] });
    await expect(subject().onDecided(tx, VERSION_ID, 'approved')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(written.updates).toEqual([]);
  });

  it('refuses with 409 when the version is not found in the acting entity', async () => {
    const { tx } = fakeTx({ versions: [] });
    await expect(subject().onDecided(tx, VERSION_ID, 'approved')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});

describe('QuotationVersionSubject.onCancelled', () => {
  it('writes nothing', async () => {
    const { tx, written } = fakeTx({ versions: [submittedRow()] });
    await subject().onCancelled(tx, VERSION_ID, 'withdrawn');
    expect(written.updates).toEqual([]);
    expect(written.inserts).toEqual([]);
  });
});

describe('quotationLinkOf', () => {
  it('returns the workspace path of the quotation that owns the version', async () => {
    const { tx } = fakeTx({ versions: [submittedRow()] });
    await expect(quotationLinkOf(tx, VERSION_ID)).resolves.toBe(`/quotations/${QUOTATION_ID}`);
  });

  it('returns undefined for a version outside the acting entity, so the inbox link applies', async () => {
    const { tx } = fakeTx({ versions: [] });
    await expect(quotationLinkOf(tx, VERSION_ID)).resolves.toBeUndefined();
  });

  it('is the subject link hook, so the decided notice opens the quotation', async () => {
    const { tx } = fakeTx({ versions: [submittedRow()] });
    await expect(subject().link(tx, VERSION_ID)).resolves.toBe(`/quotations/${QUOTATION_ID}`);
  });
});
