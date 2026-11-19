import { QuotationDetailSchema, type QuotationDetail } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { version, ID } from './contents.fixture';
import { canSeeInternalFigures, withoutInternalFigures } from './internal-data';

function detail(): QuotationDetail {
  const v1 = version({ id: '22222222-2222-4222-8222-222222222221', status: 'superseded' });
  const v2 = version({ revisionNo: 2 });
  return QuotationDetailSchema.parse({
    quotation: {
      id: ID,
      number: 'QT-2082-0042',
      customerId: v2.customerId,
      opportunityId: v2.customerId,
      currentVersionId: v2.id,
      ownerUserId: null,
      status: 'sent',
      version: 3,
      createdAt: v2.createdAt,
      updatedAt: v2.updatedAt,
    },
    versions: [v1, v2],
    statusHistory: [],
    customerName: 'Big Kahuna Burger Ltd.',
    contacts: [],
    capabilities: { canEdit: false, canRevise: false },
  });
}

describe('canSeeInternalFigures', () => {
  it('allows people who draft quotations or act on approvals', () => {
    expect(canSeeInternalFigures(['sales'])).toBe(true);
    expect(canSeeInternalFigures(['finance'])).toBe(true);
    expect(canSeeInternalFigures(['founder'])).toBe(true);
    expect(canSeeInternalFigures(['warehouse', 'sales'])).toBe(true);
  });

  it('denies everyone else, and an empty or unknown role', () => {
    expect(canSeeInternalFigures(['warehouse'])).toBe(false);
    expect(canSeeInternalFigures(['customer_user'])).toBe(false);
    expect(canSeeInternalFigures(['nobody'])).toBe(false);
    expect(canSeeInternalFigures([])).toBe(false);
  });
});

describe('withoutInternalFigures', () => {
  it('leaves no cost or margin on any line or version', () => {
    const input = detail();
    // The fixture really carries the figures, so the assertions below can fail.
    expect(input.versions.every((v) => v.marginPct !== null && v.internalCostTotal !== null)).toBe(
      true,
    );
    expect(input.versions.flatMap((v) => v.lines).every((l) => l.unitCost !== null)).toBe(true);

    const output = withoutInternalFigures(input);
    for (const v of output.versions) {
      expect(v.internalCostTotal).toBeNull();
      expect(v.marginPct).toBeNull();
      for (const line of v.lines) expect(line.unitCost).toBeNull();
    }
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain('800.25');
    expect(serialized).not.toContain('2231.40');
    expect(serialized).not.toContain('35.3200');
  });

  it('keeps the shape and every other figure, and does not mutate its input', () => {
    const input = detail();
    const output = withoutInternalFigures(input);
    expect(output.versions).toHaveLength(2);
    expect(output.versions[1]?.totals).toEqual(input.versions[1]?.totals);
    expect(output.versions[1]?.lines[0]).toMatchObject({
      description: 'Site survey',
      unitPrice: '1250.50',
      taxable: '2400.00',
    });
    expect(Object.keys(output.versions[0]!.lines[0]!)).toEqual(
      Object.keys(input.versions[0]!.lines[0]!),
    );
    expect(output.customerName).toBe(input.customerName);
    expect(input.versions[0]?.lines[0]?.unitCost).toBe('800.25');
  });
});
