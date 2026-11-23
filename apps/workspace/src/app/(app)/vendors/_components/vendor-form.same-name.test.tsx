// @vitest-environment jsdom
// TR-Q12d: when the add action answers with vendors of the same name, the form lists them and asks the
// person to confirm before the next submit adds the vendor. Driven through the real form and a stubbed action.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, mountForm, submit } from '@/test/form-interactions';

import { EMPTY_VENDOR_VALUES } from '../_lib/forms';
import type { VendorFormState } from '../_lib/state';
import { VendorForm } from './vendor-form';

const NAMESAKE = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';
const action = vi.fn<(prev: VendorFormState, form: FormData) => Promise<VendorFormState>>();

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const mount = () =>
  mountForm(
    <VendorForm
      title="Add vendor"
      action={action}
      mode="create"
      initial={{ ...EMPTY_VENDOR_VALUES, legalName: 'Himal Traders' }}
      idempotencyKey="key-1"
      cancelHref="/vendors"
      reloadHref="/vendors/new"
    />,
  );

describe('vendor form, same-name warning (TR-Q12d)', () => {
  it('lists the namesakes with their status and sends the confirmation with the next submit', async () => {
    action.mockResolvedValueOnce({
      key: 'key-1',
      errors: {},
      sameName: [
        { id: NAMESAKE, legalName: 'HIMAL TRADERS PVT LTD', status: 'blocked' },
        { id: OTHER, legalName: 'Himal Traders', status: 'approved' },
      ],
    });
    const mounted = await mount();
    try {
      await submit(mounted.container);
      const text = mounted.container.textContent ?? '';
      expect(text).toContain('A vendor with this name already exists');
      // Nothing was added, so the warning takes focus and is announced, wherever the button was pressed.
      const warning = mounted.container.querySelector<HTMLElement>('[role="alert"]');
      expect(warning?.textContent).toContain('A vendor with this name already exists');
      expect(document.activeElement).toBe(warning);
      expect(text).toContain('HIMAL TRADERS PVT LTD (Blocked)');
      expect(text).toContain('Himal Traders (Approved)');
      const link = mounted.container.querySelector<HTMLAnchorElement>(
        `a[href="/vendors/${NAMESAKE}"]`,
      );
      expect(link?.textContent).toBe('HIMAL TRADERS PVT LTD');

      const confirm = mounted.container.querySelector<HTMLInputElement>(
        'input[name="sameNameConfirmed"]',
      );
      expect(confirm?.type).toBe('checkbox');
      expect(confirm?.checked).toBe(false);
      await click(confirm);
      action.mockResolvedValueOnce({ key: 'key-1', errors: {} });
      await submit(mounted.container);
      const sent = action.mock.calls[1]?.[1];
      expect(sent?.get('sameNameConfirmed')).toBe(`${NAMESAKE},${OTHER}`);
      expect(sent?.get('idempotencyKey')).toBe('key-1');
    } finally {
      await mounted.unmount();
    }
  });

  it('shows no warning and no confirmation box before the action has found a namesake', async () => {
    const mounted = await mount();
    try {
      expect(mounted.container.textContent).not.toContain('already exists');
      expect(mounted.container.querySelector('input[name="sameNameConfirmed"]')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
