// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { CommitForm } from './decision-forms';

const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast }));

const RFQ = '11111111-1111-4111-8111-111111111111';

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

it('confirms the commitment submit in a dialog with its action in the fixed footer', async () => {
  const action = vi.fn().mockResolvedValue({
    key: 'next-key',
    count: 1,
    saved: 'Submitted for commitment approval.',
  });
  const mounted = await mountForm(
    <CommitForm action={action} idempotencyKey="request-key" rfqId={RFQ} reloadHref="/x" />,
  );
  try {
    const trigger = mounted.container.querySelector('button');
    expect(trigger?.textContent).toBe('Submit for commitment approval');
    expect(mounted.container.querySelector('form')).toBeNull();

    await click(trigger);
    const submit = document.querySelector<HTMLButtonElement>(
      '[role="dialog"] footer button[type="submit"]',
    );
    expect(submit?.form?.querySelector<HTMLInputElement>('[name="rfqId"]')?.value).toBe(RFQ);
    await click(submit);

    expect(action).toHaveBeenCalledOnce();
    const sent = action.mock.calls[0]?.[1] as FormData;
    expect(sent.get('rfqId')).toBe(RFQ);
    expect(sent.get('idempotencyKey')).toBe('request-key');
    expect(toast.success).toHaveBeenCalledExactlyOnceWith('Submitted for commitment approval.');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  } finally {
    await mounted.unmount();
  }
});

it('keeps the dialog open with the platform refusal', async () => {
  const action = vi.fn().mockResolvedValue({
    key: 'request-key',
    count: 0,
    error: 'Nobody may decide the Finance step.',
  });
  const mounted = await mountForm(
    <CommitForm action={action} idempotencyKey="request-key" rfqId={RFQ} reloadHref="/x" />,
  );
  try {
    await click(mounted.container.querySelector('button'));
    await click(document.querySelector('[role="dialog"] footer button[type="submit"]'));
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
      'Nobody may decide the Finance step.',
    );
    expect(toast.success).not.toHaveBeenCalled();
  } finally {
    await mounted.unmount();
  }
});
