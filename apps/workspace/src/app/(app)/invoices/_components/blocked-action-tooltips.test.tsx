// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Tooltip } from '@/components/ui/tooltip';
import { SendDialog } from '@/components/p2/quotations/send-dialog';
import { mountForm } from '@/test/form-interactions';

import { EditDueDateBlocked, IssueBlocked } from './action-forms';
import { PromiseBlocked } from './promise-dialog';

// UIP-FORM-011: a blocked action button carries no caption. Its reason is the design-system Tooltip's,
// opened by hover or keyboard focus, and the button stays focusable (aria-disabled, not disabled).
vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }));

let views: { unmount(): Promise<void> }[] = [];
async function show(node: ReactNode) {
  const view = await mountForm(node);
  views.push(view);
  return view.container;
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(async () => {
  for (const view of views) await view.unmount();
  views = [];
});

async function focusAndRead(container: HTMLElement) {
  const button = container.querySelector('button')!;
  expect(button.getAttribute('aria-disabled')).toBe('true');
  expect(button.hasAttribute('disabled')).toBe(false);
  expect(button.hasAttribute('title')).toBe(false);
  // Nothing but the button is in the page: no caption paragraph.
  expect(container.querySelector('p')).toBeNull();
  await act(() => Promise.resolve(button.focus()));
  expect(document.activeElement).toBe(button);
  return document.querySelector('[role="tooltip"]')?.textContent;
}

describe('a blocked action explains itself in a tooltip, with no caption', () => {
  it('Edit due date', async () => {
    const reason =
      "This invoice's due date is set when it is issued, from the sales order's credit days";
    expect(await focusAndRead(await show(<EditDueDateBlocked reason={reason} />))).toBe(reason);
  });

  it('Issue note', async () => {
    const reason = 'You created this note, so someone else with issue access must issue it.';
    expect(
      await focusAndRead(await show(<IssueBlocked kindLabel="Debit note" reason={reason} />)),
    ).toBe(reason);
  });

  it('Record promise', async () => {
    const reason = 'Nothing is owed on this invoice.';
    expect(await focusAndRead(await show(<PromiseBlocked reason={reason} />))).toBe(reason);
  });

  it('Send to customer', async () => {
    const reason = 'This quotation has expired.';
    const container = await show(
      <SendDialog
        quotationId="q"
        versionId="v"
        version={1}
        number="Q-1"
        contacts={[]}
        defaultContactId=""
        idempotencyKey="k"
        reloadHref="/quotations/q"
        blocker={reason}
      />,
    );
    expect(await focusAndRead(container)).toBe(reason);
  });
});

describe('a dialog trigger that is blocked stays focusable and does not open', () => {
  it('shows its tooltip on focus and ignores a click (the pattern the Preview and Remove buttons use)', async () => {
    const container = await show(
      <ConfirmDialog
        trigger={
          <Tooltip content="Choose a customer first.">
            <Button
              aria-disabled="true"
              onClick={(event) => {
                event.preventDefault();
              }}
            >
              Preview
            </Button>
          </Tooltip>
        }
        title="Sure?"
        description="Really?"
        confirmLabel="Yes"
        onConfirm={() => true}
      />,
    );
    const button = container.querySelector('button')!;
    await act(() => Promise.resolve(button.focus()));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Choose a customer first.',
    );
    await act(() => Promise.resolve(button.click()));
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
  });
});
