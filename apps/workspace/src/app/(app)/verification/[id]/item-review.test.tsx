import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import {
  DEFAULT_CHECKLIST,
  attachDocument,
} from '../../../../../../api/src/modules/verification/verification.rules';
import { canApprove } from '@/components/p2/customers/format';
vi.mock('./item-actions', () => ({ itemAction: vi.fn(), removeLooseAction: vi.fn() }));
import { ItemReview } from './item-review';
it('offers row decisions for provided evidence while final customer approval stays blocked', () => {
  const checklist = DEFAULT_CHECKLIST.reduce(
    (items, item) => (item.required ? attachDocument(items, item.key, item.key, null) : items),
    [...DEFAULT_CHECKLIST],
  );
  const c = {
    status: 'submitted' as const,
    reviewPolicy: 'document_review_v1' as const,
    checklist,
  };
  const files = new Map(
    checklist.filter((i) => i.required).map((i) => [i.documentId!, { status: 'clean' as const }]),
  );
  expect(canApprove(c, files)).toBe(false);
  const html = renderToStaticMarkup(
    createElement(ItemReview, {
      caseId: '11111111-1111-4111-8111-111111111111',
      itemKey: 'pan_vat_certificate',
      label: 'PAN certificate',
      version: 4,
      approveKey: 'approve-key',
      rejectKey: 'reject-key',
      canApprove: true,
    }),
  );
  expect(html).toContain('Approve</button>');
  expect(html).toContain('Reject PAN certificate');
  expect(html).toContain('Rejection reason');
  expect(html).toContain('authorized Sales creator');
  expect(html).toContain('maxLength="2000"');
  expect(html).toContain('name="expectedVersion" value="4"');
});
