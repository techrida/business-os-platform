// @vitest-environment jsdom
import type { PreviewResult } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';
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

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(() => {
  document.body.innerHTML = '';
});

describe('ApprovalPanel approver picker', () => {
  it('offers "anyone eligible" first, then each person with their role and a missing address', async () => {
    const mounted = await mountForm(
      <ApprovalPanel state="ready" preview={preview} approver="" onApproverChange={vi.fn()} />,
    );
    try {
      const { container } = mounted;
      expect(container.textContent).toContain('Approver for step 1');
      const trigger = container.querySelector<HTMLElement>('button[aria-haspopup="listbox"]')!;
      // Nobody is chosen: the picker reads "anyone eligible".
      expect(trigger.textContent).toContain('Any accountant (anyone eligible)');
      await click(trigger);
      const options = Array.from(document.querySelectorAll('[role="option"]'));
      expect(options.map((o) => o.textContent?.trim())).toEqual([
        'Any accountant (anyone eligible)',
        'Sita Sharma · Accountant',
        'Mina Rai · Sales · no email',
      ]);
      expect(options[0]!.getAttribute('aria-selected')).toBe('true');
      expect(container.textContent).not.toContain('No email');
    } finally {
      await mounted.unmount();
    }
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
