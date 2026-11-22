// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm } from '@/test/form-interactions';

import type { FieldSpec } from './setting-fields';

// U23-Q5 gap 3: with unsaved settings, clicking a notification in the bell opened the leave dialog
// but never marked the notification read, because the guard stopped the click before the bell saw
// it. The real bell is mounted here, so this fails if the guard starves its click handler again.

vi.mock('./actions', () => ({
  saveSettingsPageAction: vi.fn(),
  saveCardAction: vi.fn(),
  resetSettingAction: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const router = vi.hoisted(() => ({
  push: vi.fn<(href: string) => void>(),
  replace: vi.fn<(href: string) => void>(),
  refresh: vi.fn<() => void>(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/settings/sales',
}));
vi.mock('@/components/ui/bell-ring', () => ({
  BELL_AFTER_DOT_MS: 0,
  createBellRing: () => ({ kick: vi.fn(), cancel: vi.fn() }),
  popDot: vi.fn(),
}));
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { SettingsForm } = await import('./settings-form');
const { SettingCard } = await import('./setting-card');
const { NotificationsBell } = await import('../../notifications-bell');
const { ShellCountsProvider } = await import('@/components/shell/shell-counts');

const validity: FieldSpec = {
  key: 'quotation.validity_days',
  label: 'Quotation validity (days)',
  kind: 'integer',
  current: { kind: 'text', value: '15' },
  defaultValue: { kind: 'text', value: '15' },
  version: 2,
  defaultText: '15',
  isDefault: true,
  numberBounds: { min: 1, max: 365, step: '1' },
};

/** The visible box a field's `<label>` names; the hidden input beside it posts the value. */
const boxLabelled = (label: string): HTMLInputElement | null => {
  const tag = Array.from(document.querySelectorAll('label')).find((l) => l.textContent === label);
  const box = tag ? document.getElementById(tag.htmlFor) : null;
  return box instanceof HTMLInputElement ? box : null;
};

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const readCalls = () =>
  fetchMock.mock.calls.filter(
    ([url, init]) => url === '/api/notifications/n1/read' && init?.method === 'POST',
  );

const buttonByText = (text: string): HTMLButtonElement | null =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) ??
  null;

async function dirtyFormWithOpenBell() {
  const mounted = await mountForm(
    <div>
      <ShellCountsProvider>
        <NotificationsBell />
      </ShellCountsProvider>
      <SettingsForm section="sales" fields={[validity]}>
        <SettingCard title="Quotations" fields={[validity]} />
      </SettingsForm>
    </div>,
  );
  await fill(boxLabelled('Quotation validity (days)'), '90');
  await click(mounted.container.querySelector('button[aria-label^="Notifications"]'));
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  const link = mounted.container.querySelector<HTMLAnchorElement>('a[href="/leads/1"]');
  expect(link).not.toBeNull();
  return { mounted, link };
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', fetchMock);
  window.history.replaceState(null, '', '/settings/sales');
  router.push.mockReset();
  router.replace.mockReset();
  fetchMock.mockReset();
  fetchMock.mockImplementation((url) => {
    if (url === '/api/shell/counts') return json({ inbox: null, notifications: 1 });
    if (url === '/api/notifications') {
      return json({
        items: [
          {
            id: 'n1',
            title: 'Lead assigned to you',
            body: 'Acme',
            link: '/leads/1',
            readAt: null,
            createdLabel: 'Just now',
          },
        ],
      });
    }
    return json({});
  });
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('leaving unsaved settings through a bell notification', () => {
  it('marks the notification read and asks before leaving', async () => {
    const { mounted, link } = await dirtyFormWithOpenBell();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await act(() => {
      link?.dispatchEvent(event);
      return Promise.resolve();
    });

    expect(event.defaultPrevented).toBe(true);
    expect(readCalls()).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Leave without saving?',
    );
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();

    await click(buttonByText('Leave without saving'));
    const navigatedTo = router.replace.mock.calls[0]?.[0] ?? router.push.mock.calls[0]?.[0];
    expect(navigatedTo).toBe('/leads/1');
    await mounted.unmount();
  });

  it('keeps the unsaved value when the person stays', async () => {
    const { mounted, link } = await dirtyFormWithOpenBell();
    await act(() => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return Promise.resolve();
    });
    await click(buttonByText('Keep editing'));
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(
      mounted.container.querySelector<HTMLInputElement>('input[name="v:quotation.validity_days"]')
        ?.value,
    ).toBe('90');
    await mounted.unmount();
  });
});
