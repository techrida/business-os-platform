import type { DocumentVersionDto } from '@bos/contracts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHECKLIST,
  attachDocument,
  missingRequired,
  documentProblems,
} from '../../../../../api/src/modules/verification/verification.rules';
import { approvalFile, approveBlockedReason, canApprove, checklistProgress } from './format';

// Use the API's real upload producer: required items become provided, never pre-accepted.
const checklist = DEFAULT_CHECKLIST.reduce(
  (items, item, index) =>
    item.required
      ? attachDocument(
          items,
          item.key,
          `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          null,
        )
      : items,
  [...DEFAULT_CHECKLIST],
);
const submitted = {
  status: 'submitted' as const,
  checklist,
  reviewPolicy: 'document_review_v1' as const,
};
const clean = new Map<string, { status: DocumentVersionDto['status'] }>(
  checklist.flatMap((i) =>
    i.documentId ? [[i.documentId, { status: 'clean' as const }] as const] : [],
  ),
);

describe('approval from upload producer state', () => {
  it('requires a decision on each provided item even after all scans pass', () => {
    expect(checklistProgress(checklist)).toEqual({ accepted: 0, required: 3, complete: false });
    expect(missingRequired(checklist)).toEqual([]);
    expect(canApprove(submitted, clean)).toBe(false);
    expect(approveBlockedReason(submitted, clean)).toContain('needs approval');
    expect(
      documentProblems(
        checklist,
        [...clean].map(([documentId, v]) => ({ documentId, version: 1, ...v })),
      ),
    ).toEqual([]);
  });

  it.each([
    ['awaiting_content', 'the scan is pending'],
    ['quarantined', 'the scan is pending'],
    ['scan_failed', 'the file did not pass its scan'],
    ['infected', 'the file did not pass its scan'],
    ['rejected', 'the file did not pass its scan'],
  ] as const)('blocks %s scans with visible feedback', (status, feedback) => {
    const files = new Map(clean);
    const id = checklist[0]!.documentId!;
    files.set(id, { status });
    expect(canApprove(submitted, files)).toBe(false);
    expect(approveBlockedReason(submitted, files)).toContain(feedback);
  });

  it('blocks absent files, unavailable lookups, missing checklist items and decided cases', () => {
    expect(approveBlockedReason(submitted)).toContain('unavailable');
    expect(
      approveBlockedReason({ ...submitted, checklist: [...DEFAULT_CHECKLIST] }, clean),
    ).toContain('missing');
    for (const status of ['draft', 'approved', 'rejected', 'expired'] as const)
      expect(canApprove({ ...submitted, status }, clean)).toBe(false);
  });
});

it('uses the newest non-rejected scan and refuses rejected-only evidence', () => {
  expect(
    approvalFile([
      { version: 1, status: 'clean' },
      { version: 2, status: 'quarantined' },
    ]),
  ).toEqual({ version: 2, status: 'quarantined' });
  expect(
    approvalFile([
      { version: 1, status: 'clean' },
      { version: 2, status: 'rejected' },
    ]),
  ).toEqual({ version: 1, status: 'clean' });
  expect(approvalFile([{ version: 1, status: 'rejected' }])).toBeNull();
});
