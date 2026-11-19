import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  usePathname: () => '/settings/formats',
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
type Current = { key: string; value: unknown; version: number | null };
const getSetting = vi.fn<(session: unknown, key: string) => Promise<Current>>();
vi.mock('@/lib/api-admin', () => ({
  getSetting: (session: unknown, key: string) => getSetting(session, key),
  putSetting: vi.fn(),
}));

const { default: FormatsPage } = await import('./page');

const session = (roles: string[]): Session =>
  ({ accessToken: 't', orgKind: 'staff', roles }) as Session;

const DEFAULTS = { NPR: 'south_asian', INR: 'south_asian', USD: 'international' };

const load = (numbers: Current, date: Current) =>
  getSetting.mockImplementation((_session, key) => {
    if (key === 'format.number_systems') return Promise.resolve(numbers);
    if (key === 'format.date') return Promise.resolve(date);
    return Promise.reject(new Error(`unexpected key ${key}`));
  });

const atDefaults = () =>
  load(
    { key: 'format.number_systems', value: DEFAULTS, version: null },
    { key: 'format.date', value: 'dd MMM yyyy', version: null },
  );

/** The hidden `version` fields in the page, in order (attribute order is the renderer's business). */
const versions = (html: string): (string | undefined)[] =>
  (html.match(/<input[^>]*name="version"[^>]*>/g) ?? []).map(
    (tag) => /value="(\d*)"/.exec(tag)?.[1],
  );

const render = async (): Promise<string> =>
  renderToStaticMarkup((await FormatsPage()) as ReactElement);

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(session(['founder']));
  getSetting.mockReset();
  atDefaults();
});

afterEach(() => vi.useRealTimers());

describe('the Number and date format page', () => {
  it('renders one row for each of the three currencies, each with two choices', async () => {
    const html = await render();
    for (const label of ['NPR (Nepalese rupee)', 'INR (Indian rupee)', 'USD (US dollar)']) {
      expect(html).toContain(label);
    }
    expect(html.match(/role="radiogroup"/g)).toHaveLength(3);
    expect(html.match(/type="radio"/g)).toHaveLength(6);
    for (const currency of ['NPR', 'INR', 'USD']) {
      expect(html).toContain(`name="numberSystem:${currency}"`);
    }
    // Worked examples in each currency, drawn by the formatters documents use.
    expect(html).toContain('NPR 20,18,180.00');
    expect(html).toContain('INR 2,018,180.00');
    expect(html).toContain('USD 2,018,180.00');
    expect(html).toContain('Twenty Lakh Eighteen Thousand One Hundred Eighty Rupees Only');
    expect(html).toContain('Two Million Eighteen Thousand One Hundred Eighty Dollars Only');
  });

  it('marks the default choice of each currency as selected', async () => {
    const html = await render();
    // Attribute order is the renderer's business: read each radio tag, keep the checked ones.
    const checked = (html.match(/<input[^>]*type="radio"[^>]*>/g) ?? [])
      .filter((tag) => /\schecked(=""|\s|\/|>)/.test(tag))
      .map((tag) => {
        const name = /name="numberSystem:(\w+)"/.exec(tag)?.[1];
        const value = /value="(\w+)"/.exec(tag)?.[1];
        return `${name}:${value}`;
      });
    expect(checked).toEqual(['NPR:south_asian', 'INR:south_asian', 'USD:international']);
  });

  it('shows no undo icon while everything is at its default', async () => {
    const html = await render();
    expect(html).not.toContain('to default"');
  });

  it('shows an undo icon only on the currency that was changed, and on a changed date format', async () => {
    load(
      {
        key: 'format.number_systems',
        value: { ...DEFAULTS, INR: 'international' },
        version: 2,
      },
      { key: 'format.date', value: 'yyyy-MM-dd', version: 5 },
    );
    const html = await render();
    expect(html).toContain('aria-label="Reset INR number grouping to default"');
    expect(html).not.toContain('Reset NPR number grouping to default');
    expect(html).not.toContain('Reset USD number grouping to default');
    expect(html).toContain('aria-label="Reset Date format to default"');
  });

  it('carries the loaded version for the save, empty when it loaded the default', async () => {
    expect(versions(await render())).toEqual(['', '']);
    load(
      { key: 'format.number_systems', value: DEFAULTS, version: 3 },
      { key: 'format.date', value: 'dd MMM yyyy', version: 7 },
    );
    const html = await render();
    expect(versions(html)).toEqual(['3', '7']);
  });

  it('falls back to the defaults for a stored value it cannot read, and still shows three rows', async () => {
    load(
      { key: 'format.number_systems', value: { NPR: 'lakh' }, version: 3 },
      { key: 'format.date', value: 'dd-MM-yy', version: 2 },
    );
    const html = await render();
    expect(html.match(/role="radiogroup"/g)).toHaveLength(3);
    expect(versions(html)).toEqual(['3', '2']);
    expect(html).not.toContain('to default"');
  });

  it('says what the page is for and keeps the facts card', async () => {
    const html = await render();
    expect(html).toContain(
      'How amounts are grouped and spelled out, and how dates are written on documents.',
    );
    expect(html).toContain('Date format');
    expect(html).toContain('Always the same');
    expect(html).toContain('Asia/Kathmandu');
  });

  it('shows the failed card as a notice and the other card still renders', async () => {
    getSetting.mockImplementation((_session, key) =>
      key === 'format.number_systems'
        ? Promise.reject(Object.assign(new Error('denied'), { status: 403 }))
        : Promise.resolve({ key, value: 'dd MMM yyyy', version: null }),
    );
    const html = await render();
    expect(html).not.toContain('role="radiogroup"');
    expect(html).toContain('permission to view the number format.');
    expect(html).toContain('Date format');
  });

  it('is shut to a user without the formats section', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(FormatsPage()).rejects.toThrow('REDIRECT:/settings/denied');
    expect(getSetting).not.toHaveBeenCalled();
  });
});
