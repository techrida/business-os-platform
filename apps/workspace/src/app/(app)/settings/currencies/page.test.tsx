import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { SETTING_DEFAULTS, type SettingKey } from '@bos/contracts';

import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  usePathname: () => '/settings/currencies',
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const founder = { accessToken: 't', orgKind: 'staff', roles: ['founder'] } as Session;
vi.mock('@/lib/session', () => ({ getSession: () => Promise.resolve(founder) }));
const api = vi.hoisted(() => ({ getSetting: vi.fn() }));
vi.mock('@/lib/api-admin', () => ({
  getSetting: api.getSetting,
  putSetting: vi.fn(),
  listFxRates: vi.fn().mockResolvedValue([]),
  addFxRate: vi.fn(),
}));

const { default: CurrenciesPage } = await import('./page');

describe('the currencies page', () => {
  it('shows the currencies in use, with NPR locked on, beside the rate age', async () => {
    api.getSetting.mockImplementation((_s: Session, key: SettingKey) =>
      Promise.resolve({
        key,
        value: key === 'currency.enabled' ? ['NPR', 'USD'] : SETTING_DEFAULTS[key],
        version: key === 'currency.enabled' ? 3 : null,
      }),
    );
    const html = renderToStaticMarkup((await CurrenciesPage()) as ReactElement);

    // Fails on the old page, which loaded only fx.max_rate_age_days.
    expect(api.getSetting.mock.calls.map((call) => call[1] as SettingKey)).toContain(
      'currency.enabled',
    );
    expect(html).toContain('Currencies in use');
    expect(html).toContain('NPR (always on)');
    const box = (code: string) => html.match(new RegExp(`<input[^>]*value="${code}"[^>]*/>`))?.[0];
    expect(box('USD')).toContain('checked');
    expect(box('INR')).toBeDefined();
    expect(box('INR')).not.toContain('checked');
    expect(html).toContain('Oldest exchange rate allowed (days)');
    // Before hydration the visible box posts the rate (a hidden input takes over after); it checks digits itself, with no browser pattern.
    const rate = html.match(/<input[^>]*name="rateNpr"[^>]*\/>/g);
    expect(rate).toHaveLength(1);
    expect(rate?.[0]).toContain('type="text"');
    expect(html).not.toContain('\\d{1,12}');
    // No raw key in the visible text (hidden form fields carry it on purpose).
    expect(html.replace(/<[^>]*>/g, ' ')).not.toContain('currency.enabled');
  });
});
