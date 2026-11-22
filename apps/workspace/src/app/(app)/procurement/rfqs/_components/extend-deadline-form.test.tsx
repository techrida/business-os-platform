// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import type { RfqEditState } from '../_lib/state';
import { ExtendDeadlineForm } from './decision-forms';

const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast }));

const RFQ = '11111111-1111-4111-8111-111111111111';
const DEADLINE = '2026-11-20T04:15:00.000Z';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

type Action = (prev: RfqEditState, form: FormData) => Promise<RfqEditState>;

const mount = (action: Action, passed = true) =>
  mountForm(
    <ExtendDeadlineForm
      action={action}
      idempotencyKey="request-key"
      rfqId={RFQ}
      deadline={DEADLINE}
      deadlineText="20 Nov 2026, 10:00"
      passed={passed}
      reloadHref="/x"
    />,
  );

it('extends from a dialog that starts at the current Kathmandu deadline (F1-Q47)', async () => {
  const action = vi.fn<Action>().mockResolvedValue({
    key: 'next-key',
    errors: {},
    count: 1,
    saved: 'Deadline extended to 25 Nov 2026, 10:00.',
  });
  const mounted = await mount(action);
  try {
    const trigger = mounted.container.querySelector('button');
    expect(trigger?.textContent).toBe('Extend deadline');
    expect(mounted.container.querySelector('form')).toBeNull();

    await click(trigger);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('The deadline passed on 20 Nov 2026, 10:00.');
    // The app's date-and-time picker, not the browser's datetime-local box (UIP-FORM-004).
    expect(dialog?.querySelector('input[type="datetime-local"]')).toBeNull();
    expect(dialog?.querySelector('button[aria-label="Calendar"]')).not.toBeNull();
    const input = dialog?.querySelector<HTMLInputElement>('input[type="hidden"][name="deadline"]');
    expect(input?.value).toBe('2026-11-20T10:00');

    await click(document.querySelector('[role="dialog"] footer button[type="submit"]'));
    expect(action).toHaveBeenCalledOnce();
    const sent = action.mock.calls[0]?.[1] as FormData;
    expect(sent.get('rfqId')).toBe(RFQ);
    expect(sent.get('currentDeadline')).toBe(DEADLINE);
    expect(sent.get('deadline')).toBe('2026-11-20T10:00');
    expect(sent.get('idempotencyKey')).toBe('request-key');
    expect(toast.success).toHaveBeenCalledExactlyOnceWith(
      'Deadline extended to 25 Nov 2026, 10:00.',
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await mounted.unmount();
  }
});

it('keeps the dialog open with the refusal next to the field', async () => {
  const action = vi.fn<Action>().mockResolvedValue({
    key: 'request-key',
    errors: { deadline: 'Choose a deadline later than the current one.' },
    count: 0,
  });
  const mounted = await mount(action, false);
  try {
    await click(mounted.container.querySelector('button'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Quotations close on 20 Nov 2026, 10:00.',
    );
    await click(document.querySelector('[role="dialog"] footer button[type="submit"]'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Choose a deadline later than the current one.',
    );
    expect(toast.success).not.toHaveBeenCalled();
  } finally {
    await mounted.unmount();
  }
});
