import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import {
  DEFAULT_CHECKLIST,
  attachDocument,
} from '../../../../../../api/src/modules/verification/verification.rules';
import { approveBlockedReason, canApprove } from '@/components/p2/customers/format';

vi.mock('../actions', () => ({ reviewAction: vi.fn() }));
import { ReviewForm } from './review-form';

it('renders an enabled approve control from real provided uploads, and visible scan feedback otherwise', () => {
  const checklist = DEFAULT_CHECKLIST.reduce(
    (items, item) => (item.required ? attachDocument(items, item.key, item.key, null) : items),
    [...DEFAULT_CHECKLIST],
  );
  const c = { status: 'submitted' as const, checklist };
  const files = new Map(
    checklist.filter((i) => i.required).map((i) => [i.documentId!, { status: 'clean' as const }]),
  );
  const render = (ready: boolean, reason: string | null) =>
    renderToStaticMarkup(
      createElement(ReviewForm, {
        caseId: '11111111-1111-4111-8111-111111111111',
        version: 3,
        reloadHref: '/verification/test',
        idempotencyKey: '55555555-5555-4555-8555-555555555555',
        canApprove: ready,
        canReject: true,
        approveBlockedReason: reason,
      }),
    );
  const html = render(canApprove(c, files), approveBlockedReason(c, files));
  expect(html).toMatch(/<button[^>]*value="approve"/);
  expect(html.match(/<button[^>]*value="approve"[^>]*>/)?.[0]).not.toContain('disabled');
  expect(html).not.toContain('accepted (0');
  const reason = approveBlockedReason(c);
  expect(render(canApprove(c), reason)).toContain('unavailable');
});
