import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

// F1-Q32: the delivery-hold threshold (`sales.delivery_hold.management_npr`) is edited on Settings > Sales. The API
// lets only admin.settings.write change it (settingEditors in apps/api settings-access.ts), and the Sales section is
// gated on the same permission, so a finance-settings grant alone does not open it.

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  usePathname: () => '/settings/sales',
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const getMe =
  vi.fn<(token: string) => Promise<{ permissions?: { permission: string; scope: string }[] }>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getMe: (session: { accessToken: string }) => getMe(session.accessToken),
}));
const admin = vi.hoisted(() => ({ getSetting: vi.fn(), putSetting: vi.fn() }));
vi.mock('@/lib/api-admin', () => admin);
vi.mock('@/lib/api-lead-lost-reasons', () => ({ listLeadLostReasons: vi.fn(() => []) }));

const { default: SalesPage } = await import('./page');
const { saveSettingsPageAction } = await import('../_components/actions');

const KEY = 'sales.delivery_hold.management_npr' as const;

function persona(token: string, roles: string[], ...permissions: string[]): void {
  getMe.mockImplementation((asked) =>
    Promise.resolve(
      asked === token
        ? { permissions: permissions.map((permission) => ({ permission, scope: 'all' })) }
        : {},
    ),
  );
  getSession.mockResolvedValue({ accessToken: token, orgKind: 'staff', roles } as Session);
}

const SAVED: Record<string, unknown> = {
  'quotation.validity_days': 15,
  'sales.evidence_policy': 'signed_quote',
  'sales.default_schedule': [{ label: 'Full payment', percent: '100', trigger: 'delivery' }],
  [KEY]: '250000.50',
};

const render = async () => renderToStaticMarkup((await SalesPage()) as ReactElement);

beforeEach(() => {
  vi.clearAllMocks();
  admin.getSetting.mockImplementation((_session: unknown, key: string) =>
    Promise.resolve({ key, value: SAVED[key], version: 4 }),
  );
});

describe('the delivery hold card', () => {
  it('shows the saved threshold as a money field to the Founder', async () => {
    persona('founder-live', ['sales'], 'admin.settings.write');
    const html = await render();
    expect(admin.getSetting).toHaveBeenCalledWith(expect.anything(), KEY);
    expect(html).toContain('Delivery holds');
    expect(html).toContain('Management releases holds above (NPR)');
    const input = html.match(/<input[^>]*name="v:sales\.delivery_hold\.management_npr"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    expect(input).toContain('type="number"');
    expect(input).toContain('step="0.01"');
    expect(input).toContain('min="0"');
    expect(input).toContain('value="250000.50"');
  });

  it('keeps the other cards when the threshold cannot be read', async () => {
    persona('founder-live', ['sales'], 'admin.settings.write');
    admin.getSetting.mockImplementation((_session: unknown, key: string) =>
      key === KEY
        ? Promise.reject(new Error('down'))
        : Promise.resolve({ key, value: SAVED[key], version: 4 }),
    );
    const html = await render();
    expect(html).not.toContain('Management releases holds above (NPR)');
    expect(html).toContain('Quotation validity (days)');
  });

  it('is not shown to a finance-settings grant: the API keeps this key with admin.settings.write', async () => {
    persona('accountant-live', ['accountant'], 'settings.finance.write');
    await expect(render()).rejects.toThrow('REDIRECT:/settings/terms');
    expect(admin.getSetting).not.toHaveBeenCalled();
  });
});

describe('saving the delivery-hold threshold', () => {
  const change = {
    key: KEY,
    value: { kind: 'text' as const, value: ' 150000.5 ' },
    expectedVersion: 4,
  };

  it('writes the trimmed amount as decimal text for the Founder', async () => {
    persona('founder-live', ['sales'], 'admin.settings.write');
    admin.putSetting.mockResolvedValue({ version: 5 });
    await expect(saveSettingsPageAction('sales', [change])).resolves.toMatchObject({
      status: 'ok',
    });
    expect(admin.putSetting).toHaveBeenCalledWith(expect.anything(), KEY, '150000.5', 4);
  });

  it('refuses a third decimal next to the field, before any write', async () => {
    persona('founder-live', ['sales'], 'admin.settings.write');
    const result = await saveSettingsPageAction('sales', [
      { ...change, value: { kind: 'text', value: '150000.555' } },
    ]);
    expect(result.status).toBe('error');
    expect(result.fieldErrors[KEY]).toBe(
      'Enter an amount of 0 or more with up to two decimal places.',
    );
    expect(admin.putSetting).not.toHaveBeenCalled();
  });

  it('refuses a finance-settings grant before any write', async () => {
    persona('accountant-live', ['accountant'], 'settings.finance.write');
    await expect(saveSettingsPageAction('sales', [change])).rejects.toThrow('REDIRECT:');
    expect(admin.putSetting).not.toHaveBeenCalled();
  });
});
