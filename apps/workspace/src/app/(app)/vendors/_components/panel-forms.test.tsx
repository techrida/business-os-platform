// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { lifecycleOptions } from '../_lib/model';
import { LifecycleForm } from './panel-forms';

const actions = vi.hoisted(() => ({
  addContactAction: vi.fn(),
  decideBankAction: vi.fn(),
  grantPortalAction: vi.fn(),
  lifecycleAction: vi.fn(),
  proposeBankAction: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../actions', () => actions);
vi.mock('@/components/ui/toast', () => ({ toast }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const optionFor = (
  status: 'draft' | 'under_review' | 'approved' | 'blocked',
  command: 'submit_kyc' | 'activate' | 'suspend' | 'block' | 'archive',
) => {
  const option = lifecycleOptions(status, { write: true, activate: true }).find(
    (candidate) => candidate.command === command,
  );
  if (!option) throw new Error(`Missing lifecycle option ${command}`);
  return option;
};

async function typeReason(value: string) {
  const reason = document.querySelector<HTMLTextAreaElement>('textarea[name="reason"]');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(reason, value);
  await act(() => Promise.resolve(reason?.dispatchEvent(new Event('input', { bubbles: true }))));
}

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

describe('vendor lifecycle confirmation', () => {
  it.each([
    ['approved', 'suspend', 'Suspend vendor'],
    ['approved', 'block', 'Block vendor'],
    ['blocked', 'archive', 'Archive vendor'],
  ] as const)(
    'confirms %s to %s in a labelled dialog with the reason in its body and the actions in its footer',
    async (status, command, label) => {
      const mounted = await mountForm(
        <LifecycleForm
          vendorId="vendor-id"
          status={status}
          option={optionFor(status, command)}
          idempotencyKey="request-key"
        />,
      );
      try {
        const trigger = mounted.container.querySelector('button');
        expect(trigger?.textContent).toBe(label);
        expect(mounted.container.querySelector('[type="submit"]')).toBeNull();

        await click(trigger);
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog?.getAttribute('aria-labelledby')).toBeTruthy();
        expect(dialog?.textContent).toContain(`${label}?`);

        const reason = dialog?.querySelector<HTMLTextAreaElement>('textarea[name="reason"]');
        expect(reason?.required).toBe(true);
        const form = reason?.form;
        expect(form?.querySelector<HTMLInputElement>('[name="command"]')?.value).toBe(command);
        expect(form?.querySelector<HTMLInputElement>('[name="idempotencyKey"]')?.value).toBe(
          'request-key',
        );

        const footer = dialog?.querySelector('footer');
        const submit = footer?.querySelector<HTMLButtonElement>('button[type="submit"]');
        expect(submit?.textContent).toBe(label);
        expect(submit?.form).toBe(form);
        expect(footer?.textContent).toContain('Cancel');
      } finally {
        await mounted.unmount();
      }
    },
  );

  it.each([
    ['draft', 'submit_kyc', 'Start KYB review'],
    ['under_review', 'activate', 'Approve vendor'],
  ] as const)(
    'confirms %s to %s in a fixed-footer dialog without a reason field',
    async (status, command, label) => {
      const mounted = await mountForm(
        <LifecycleForm
          vendorId="vendor-id"
          status={status}
          option={optionFor(status, command)}
          idempotencyKey="request-key"
        />,
      );
      try {
        const trigger = mounted.container.querySelector('button');
        expect(trigger?.textContent).toBe(label);
        expect(mounted.container.querySelector('[type="submit"]')).toBeNull();

        await click(trigger);
        const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
        expect(dialog).not.toBeNull();
        expect(dialog?.querySelector('textarea[name="reason"]')).toBeNull();
        const form = dialog?.querySelector('form');
        expect(form?.querySelector<HTMLInputElement>('[name="command"]')?.value).toBe(command);

        const footer = dialog?.querySelector('footer');
        const submit = footer?.querySelector<HTMLButtonElement>('button[type="submit"]');
        expect(submit?.textContent).toBe(label);
        expect(submit?.form).toBe(form);
      } finally {
        await mounted.unmount();
      }
    },
  );

  it('sends the reason, toasts the confirmation and closes after a success', async () => {
    actions.lifecycleAction.mockResolvedValue({
      key: 'next-key',
      errors: {},
      saved: 'The vendor was blocked.',
      savedCount: 1,
    });
    const mounted = await mountForm(
      <LifecycleForm
        vendorId="vendor-id"
        status="approved"
        option={optionFor('approved', 'block')}
        idempotencyKey="request-key"
      />,
    );
    try {
      await click(mounted.container.querySelector('button'));
      await typeReason('Fraud alert from the bank');
      await click(document.querySelector('footer button[type="submit"]'));

      expect(actions.lifecycleAction).toHaveBeenCalledOnce();
      const sent = actions.lifecycleAction.mock.calls[0]?.[1] as FormData;
      expect(sent.get('vendorId')).toBe('vendor-id');
      expect(sent.get('command')).toBe('block');
      expect(sent.get('reason')).toBe('Fraud alert from the bank');
      expect(sent.get('idempotencyKey')).toBe('request-key');
      expect(toast.success).toHaveBeenCalledExactlyOnceWith('The vendor was blocked.');
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it('keeps the dialog open with the refusal and the typed reason', async () => {
    actions.lifecycleAction.mockResolvedValue({
      key: 'request-key',
      errors: {},
      error: 'Only an approver may block a vendor.',
      savedCount: 0,
    });
    const mounted = await mountForm(
      <LifecycleForm
        vendorId="vendor-id"
        status="approved"
        option={optionFor('approved', 'block')}
        idempotencyKey="request-key"
      />,
    );
    try {
      await click(mounted.container.querySelector('button'));
      await typeReason('Duplicate record');
      await click(document.querySelector('footer button[type="submit"]'));

      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog?.querySelector('[role="alert"]')?.textContent).toContain(
        'Only an approver may block a vendor.',
      );
      expect(dialog?.querySelector<HTMLTextAreaElement>('textarea[name="reason"]')?.value).toBe(
        'Duplicate record',
      );
      expect(toast.success).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });
  it('sends the status the KYB button was drawn for', async () => {
    actions.lifecycleAction.mockResolvedValue({
      key: 'next-key',
      errors: {},
      saved: 'KYB review started.',
      savedCount: 1,
    });
    const mounted = await mountForm(
      <LifecycleForm
        vendorId="vendor-id"
        status="draft"
        option={optionFor('draft', 'submit_kyc')}
        idempotencyKey="request-key"
      />,
    );
    try {
      await click(mounted.container.querySelector('button'));
      await click(document.querySelector('footer button[type="submit"]'));
      const sent = actions.lifecycleAction.mock.calls[0]?.[1] as FormData;
      expect(sent.get('command')).toBe('submit_kyc');
      expect(sent.get('expectedStatus')).toBe('draft');
    } finally {
      await mounted.unmount();
    }
  });

  it('a stale button: shows the refusal as a toast and closes, as the page has been redrawn', async () => {
    actions.lifecycleAction.mockResolvedValue({
      key: 'next-key',
      errors: {},
      error: 'This vendor changed since you opened it. Reload and try again.',
      reload: true,
      refreshed: true,
      savedCount: 0,
    });
    const mounted = await mountForm(
      <LifecycleForm
        vendorId="vendor-id"
        status="draft"
        option={optionFor('draft', 'submit_kyc')}
        idempotencyKey="request-key"
      />,
    );
    try {
      await click(mounted.container.querySelector('button'));
      await click(document.querySelector('footer button[type="submit"]'));
      expect(toast.error).toHaveBeenCalledExactlyOnceWith(
        'This vendor changed since you opened it. Reload and try again.',
      );
      expect(toast.success).not.toHaveBeenCalled();
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
