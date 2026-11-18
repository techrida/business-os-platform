import type { PreviewResult } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { ApprovalPanel, approverOptionLabel } from './approval-panel';

const ACC = '11111111-1111-4111-8111-111111111111';
const MATE = '22222222-2222-4222-8222-222222222222';

const preview: PreviewResult = {
  totals: {
    subtotal: '100.00',
    discountAmount: '0.00',
    taxableAmount: '100.00',
    taxAmount: '13.00',
    total: '113.00',
    effectiveDiscountPct: '0',
  },
  taxSummary: [],
  route: {
    blocked: false,
    steps: [
      {
        seq: 1,
        kind: 'role',
        roleKey: 'accountant',
        reason: 'Base route: accountant checks the quotation',
        blocked: false,
        eligibleUserIds: [],
      },
      {
        seq: 2,
        kind: 'role',
        roleKey: 'finance',
        reason: 'Base route: finance approves',
        blocked: false,
        eligibleUserIds: [],
      },
    ],
  },
  approverChoice: {
    seq: 1,
    options: [
      { userId: ACC, name: 'Sita Sharma', roleKey: 'accountant', hasEmail: true },
      { userId: MATE, name: 'Mina Rai', roleKey: 'sales', hasEmail: false },
    ],
  },
};

const render = (approver: string) =>
  renderToStaticMarkup(
    <ApprovalPanel
      state="ready"
      preview={preview}
      approver={approver}
      onApproverChange={vi.fn()}
    />,
  );

describe('ApprovalPanel approver picker', () => {
  it('offers "anyone eligible" first, then each person with their role and a missing address', () => {
    const html = render('');
    expect(html).toContain('Approver for step 1');
    expect(html).toContain(
      '<option value="" selected="">Any accountant (anyone eligible)</option>',
    );
    expect(html).toContain(`<option value="${ACC}">Sita Sharma · Accountant</option>`);
    expect(html).toContain(`<option value="${MATE}">Mina Rai · Sales · no email</option>`);
    expect(html).not.toContain('No email');
  });

  it('names the chosen person on the step and flags that they get no email', () => {
    const html = render(MATE);
    expect(html).toContain('Chosen');
    expect(html).toContain('No email');
    expect(html).toContain('They get a bell notice and the Inbox item, not an email.');
  });

  it('labels an option in words', () => {
    expect(approverOptionLabel(preview.approverChoice!.options[0]!)).toBe(
      'Sita Sharma · Accountant',
    );
  });
});
