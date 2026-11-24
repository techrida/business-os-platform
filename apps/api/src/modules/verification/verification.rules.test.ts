// Unit tests of the pure KYB rules (no database): the default checklist, attaching a document, what a
// submit needs, what an approval needs, and what reopening an expired case clears.
import {
  CHECKLIST_ITEM_KEYS,
  REQUIRED_VENDOR_CHECKLIST_KEYS,
  VENDOR_CHECKLIST_ITEM_KEYS,
  type ChecklistItem,
  ChecklistItemSchema,
  type DocumentVersionDto,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CHECKLIST,
  acceptProvided,
  attachDocument,
  checklistKeysFor,
  defaultChecklistFor,
  documentProblems,
  isEditable,
  missingRequired,
  reopenChecklist,
  requiresExpiry,
} from './verification.rules';

const DOC_A = '11111111-1111-4111-8111-111111111111';
const DOC_B = '22222222-2222-4222-8222-222222222222';

const provide = (items: readonly ChecklistItem[], key: ChecklistItem['key'], documentId: string) =>
  attachDocument(items, key, documentId, null);

const version = (documentId: string, status: DocumentVersionDto['status'], v = 1) => ({
  documentId,
  version: v,
  status,
});

describe('DEFAULT_CHECKLIST', () => {
  it('holds only valid, missing items and at least one required item', () => {
    for (const item of DEFAULT_CHECKLIST) {
      expect(ChecklistItemSchema.safeParse(item).success).toBe(true);
      expect(item.status).toBe('missing');
    }
    expect(DEFAULT_CHECKLIST.some((i) => i.required)).toBe(true);
  });
});

describe('isEditable', () => {
  it('lets a draft or a rejected case take changes, and nothing else', () => {
    expect(isEditable('draft')).toBe(true);
    expect(isEditable('rejected')).toBe(true);
    for (const status of ['submitted', 'approved', 'expired'] as const) {
      expect(isEditable(status)).toBe(false);
    }
  });
});

describe('attachDocument', () => {
  it('marks the item provided with its document and expiry, and leaves the input alone', () => {
    const next = attachDocument(DEFAULT_CHECKLIST, 'registration_certificate', DOC_A, '2027-01-31');
    const item = next.find((i) => i.key === 'registration_certificate')!;
    expect(item).toMatchObject({ status: 'provided', documentId: DOC_A, expiresOn: '2027-01-31' });
    expect(DEFAULT_CHECKLIST.find((i) => i.key === 'registration_certificate')!.status).toBe(
      'missing',
    );
    expect(next.every((i) => ChecklistItemSchema.safeParse(i).success)).toBe(true);
  });

  it('adds an optional item when the stored checklist lacks the key', () => {
    expect(attachDocument([], 'other', DOC_A, null)).toEqual([
      { key: 'other', required: false, status: 'provided', documentId: DOC_A, expiresOn: null },
    ]);
  });

  it('replaces the document of an item that already had one', () => {
    const second = provide(
      provide(DEFAULT_CHECKLIST, 'address_proof', DOC_A),
      'address_proof',
      DOC_B,
    );
    expect(second.find((i) => i.key === 'address_proof')!.documentId).toBe(DOC_B);
  });
});

describe('missingRequired', () => {
  it('names every required item that has no document', () => {
    expect(missingRequired(DEFAULT_CHECKLIST)).toEqual(
      DEFAULT_CHECKLIST.filter((i) => i.required).map((i) => i.key),
    );
  });

  it('is empty once every required item is provided', () => {
    let items: readonly ChecklistItem[] = DEFAULT_CHECKLIST;
    for (const i of DEFAULT_CHECKLIST.filter((x) => x.required))
      items = provide(items, i.key, DOC_A);
    expect(missingRequired(items)).toEqual([]);
  });

  it('counts a rejected item as missing', () => {
    const rejected: ChecklistItem[] = [
      { key: 'other', required: true, status: 'rejected', documentId: DOC_A, expiresOn: null },
    ];
    expect(missingRequired(rejected)).toEqual(['other']);
  });

  it('reports a checklist with no required item at all (a case needs one)', () => {
    expect(missingRequired([])).toEqual(['no_required_item']);
  });
});

describe('documentProblems', () => {
  const items: ChecklistItem[] = [
    { key: 'other', required: true, status: 'provided', documentId: DOC_A, expiresOn: null },
    {
      key: 'address_proof',
      required: true,
      status: 'provided',
      documentId: DOC_B,
      expiresOn: null,
    },
    {
      key: 'pan_vat_certificate',
      required: false,
      status: 'missing',
      documentId: null,
      expiresOn: null,
    },
  ];

  it('passes when the newest usable version of each required document is clean', () => {
    expect(documentProblems(items, [version(DOC_A, 'clean'), version(DOC_B, 'clean')])).toEqual([]);
  });

  it('flags a required document that is absent, still scanning or infected', () => {
    expect(documentProblems(items, [version(DOC_A, 'clean')])).toEqual(['address_proof']);
    expect(documentProblems(items, [version(DOC_A, 'infected'), version(DOC_B, 'clean')])).toEqual([
      'other',
    ]);
    expect(
      documentProblems(items, [version(DOC_A, 'clean'), version(DOC_B, 'quarantined')]),
    ).toEqual(['address_proof']);
  });

  it('judges a document by its newest version that was not rejected', () => {
    expect(
      documentProblems(items, [
        version(DOC_A, 'infected', 1),
        version(DOC_A, 'clean', 2),
        version(DOC_B, 'clean', 1),
        version(DOC_B, 'rejected', 2),
      ]),
    ).toEqual([]);
  });
});

describe('acceptProvided', () => {
  it('turns provided items into accepted and leaves missing ones', () => {
    const accepted = acceptProvided(provide(DEFAULT_CHECKLIST, 'registration_certificate', DOC_A));
    expect(accepted.find((i) => i.key === 'registration_certificate')!.status).toBe('accepted');
    expect(accepted.find((i) => i.key === 'other')!.status).toBe('missing');
  });
});

describe('reopenChecklist', () => {
  it('empties the items whose document expired on or before today and keeps the rest', () => {
    let items = attachDocument(DEFAULT_CHECKLIST, 'registration_certificate', DOC_A, '2026-11-01');
    items = attachDocument(items, 'pan_vat_certificate', DOC_B, '2027-06-30');
    items = attachDocument(items, 'address_proof', DOC_B, null);
    const reopened = reopenChecklist(acceptProvided(items), '2026-11-09');
    const by = (key: string) => reopened.find((i) => i.key === key)!;
    expect(by('registration_certificate')).toMatchObject({
      status: 'missing',
      documentId: null,
      expiresOn: null,
    });
    expect(by('pan_vat_certificate')).toMatchObject({ status: 'accepted', documentId: DOC_B });
    expect(by('address_proof')).toMatchObject({ status: 'accepted', documentId: DOC_B });
    expect(reopened.every((i) => ChecklistItemSchema.safeParse(i).success)).toBe(true);
  });
});

describe('the checklist by party kind', () => {
  it('gives a customer the unchanged default checklist', () => {
    expect(defaultChecklistFor('customer')).toEqual(DEFAULT_CHECKLIST);
    expect(checklistKeysFor('customer')).toEqual(CHECKLIST_ITEM_KEYS);
  });

  it('gives a vendor one empty valid item per vendor key, with at least one required', () => {
    const vendor = defaultChecklistFor('vendor');
    expect(vendor.map((i) => i.key)).toEqual([...VENDOR_CHECKLIST_ITEM_KEYS]);
    expect(checklistKeysFor('vendor')).toEqual(VENDOR_CHECKLIST_ITEM_KEYS);
    expect(vendor.every((i) => ChecklistItemSchema.safeParse(i).success)).toBe(true);
    expect(vendor.every((i) => i.status === 'missing')).toBe(true);
    expect(vendor.some((i) => i.required)).toBe(true);
    expect(vendor.some((i) => i.key === 'tax_clearance' && i.required)).toBe(true);
  });

  it('requires exactly the documents the contract lists as owed by every vendor', () => {
    expect(
      defaultChecklistFor('vendor')
        .filter((i) => i.required)
        .map((i) => i.key),
    ).toEqual([...REQUIRED_VENDOR_CHECKLIST_KEYS]);
  });

  it('keeps the two key sets apart', () => {
    for (const key of VENDOR_CHECKLIST_ITEM_KEYS) {
      expect((CHECKLIST_ITEM_KEYS as readonly string[]).includes(key)).toBe(false);
    }
  });
});

describe('expiry-required items', () => {
  it('requires an expiry for the tax clearance and for nothing else', () => {
    expect(requiresExpiry('tax_clearance')).toBe(true);
    expect(requiresExpiry('pan_certificate')).toBe(false);
    expect(requiresExpiry('registration_certificate')).toBe(false);
  });

  it('counts a tax clearance without an expiry as missing, and with one as provided', () => {
    const vendor = defaultChecklistFor('vendor');
    let items: readonly ChecklistItem[] = vendor;
    for (const i of vendor.filter((x) => x.required && x.key !== 'tax_clearance')) {
      items = attachDocument(items, i.key, DOC_A, null);
    }
    expect(missingRequired(attachDocument(items, 'tax_clearance', DOC_B, null))).toEqual([
      'tax_clearance',
    ]);
    expect(missingRequired(attachDocument(items, 'tax_clearance', DOC_B, '2027-07-15'))).toEqual(
      [],
    );
  });
});
