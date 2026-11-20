import { describe, expect, it } from 'vitest';

import { ConfirmEvidenceBodySchema, QuotationEvidenceDtoSchema } from './quotation-evidence.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('ConfirmEvidenceBodySchema (F1-Q28)', () => {
  it('needs at least one kind, each once, and defaults the files to none', () => {
    expect(ConfirmEvidenceBodySchema.parse({ evidenceKinds: ['contract'] })).toEqual({
      evidenceKinds: ['contract'],
      evidenceDocumentIds: [],
    });
    expect(ConfirmEvidenceBodySchema.safeParse({ evidenceKinds: [] }).success).toBe(false);
    expect(
      ConfirmEvidenceBodySchema.safeParse({ evidenceKinds: ['contract', 'contract'] }).success,
    ).toBe(false);
  });

  it('is strict and refuses a blank note', () => {
    expect(
      ConfirmEvidenceBodySchema.safeParse({ evidenceKinds: ['contract'], status: 'confirmed' })
        .success,
    ).toBe(false);
    expect(
      ConfirmEvidenceBodySchema.safeParse({ evidenceKinds: ['contract'], comment: '  ' }).success,
    ).toBe(false);
  });
});

describe('QuotationEvidenceDtoSchema', () => {
  it('parses a pending portal acceptance', () => {
    const dto = {
      quotationId: id(1),
      versionId: id(2),
      status: 'pending',
      policy: 'both',
      missing: ['contract', 'purchase_order'],
      acceptance: {
        actorKind: 'customer_user',
        decidedOn: '2026-11-20',
        acceptedByName: 'Ram Thapa',
        evidenceKinds: ['signed_quote'],
        evidenceDocumentIds: [],
      },
      confirmation: null,
      can: { confirm: true },
    };
    expect(QuotationEvidenceDtoSchema.parse(dto)).toEqual(dto);
  });
});
