import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import {
  DEFAULT_CHECKLIST,
  attachDocument,
} from '../../../../../../api/src/modules/verification/verification.rules';
import { approvalProblems, type ApprovalFile } from '@/components/p2/customers/format';

vi.mock('../actions', () => ({ reviewAction: vi.fn() }));
import { ReviewForm } from './review-form';

it('renders an enabled approve control from real provided uploads, and visible scan feedback otherwise', () => {
  const checklist = DEFAULT_CHECKLIST.reduce(
    (items, item) =>
      item.required || item.key === 'other'
        ? attachDocument(items, item.key, item.key, null)
        : items,
    [...DEFAULT_CHECKLIST],
  );
  const c = { status: 'submitted' as const, checklist };
  const files = new Map(
    checklist.flatMap((item) =>
      item.documentId ? [[item.documentId, { status: 'clean' as const }]] : [],
    ),
  );
  const render = (problems: string[]) =>
    renderToStaticMarkup(
      createElement(ReviewForm, {
        caseId: '11111111-1111-4111-8111-111111111111',
        version: 3,
        reloadHref: '/verification/test',
        idempotencyKey: '55555555-5555-4555-8555-555555555555',
        canReject: true,
        approvalProblems: problems,
      }),
    );
  expect(render(approvalProblems(c, files))).toMatch(
    /<button(?![^>]*disabled)[^>]*>Approve customer<\/button>/,
  );

  const scanning = new Map<string, ApprovalFile>(files);
  scanning.set('other', { status: 'quarantined' });
  const blocked = render(approvalProblems(c, scanning));
  expect(blocked).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Approve customer<\/button>/);
  expect(blocked).toContain('Other supporting document: the scan is pending.');
  expect(blocked).toMatch(/<button(?![^>]*disabled)[^>]*>Reject<\/button>/);
});
