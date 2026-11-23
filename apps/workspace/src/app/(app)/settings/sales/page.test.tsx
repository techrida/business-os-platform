import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

// F1-Q32 and F1-Q21: the delivery-hold threshold (`sales.delivery_hold.management_npr`) and the default lead owner
// (`crm.default_lead_owner`) are edited on Settings > Sales. The API lets only admin.settings.write change either
// (settingEditors in apps/api settings-access.ts), and the Sales section is gated on the same permission, so a
// finance-settings grant alone does not open it.

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
const admin = vi.hoisted(() => ({
  getSetting: vi.fn(),
  putSetting: vi.fn(),
  listDefaultLeadOwnerPeople: vi.fn(),
}));
vi.mock('@/lib/api-admin', () => admin);
vi.mock('@/lib/api-lead-lost-reasons', () => ({ listLeadLostReasons: vi.fn(() => []) }));
const crm = vi.hoisted(() => ({ listLeadOwners: vi.fn() }));
vi.mock('@/components/p2/crm/crm-api', () => crm);

const { default: SalesPage } = await import('./page');
const { saveSettingsPageAction } = await import('../_components/actions');

const KEY = 'sales.delivery_hold.management_npr' as const;
const OWNER_KEY = 'crm.default_lead_owner' as const;
const RAM = '3f0c5a52-7c2e-4d0b-9a55-0e8d1d6a3b11';
const GITA = '7a1e2b3c-4d5e-4f60-8a7b-8c9d0e1f2a3b';
/** GET /v1/admin/settings/crm.default_lead_owner/people as the API answers it (SettingsPerson[]). */
const OWNERS = [
  { userId: RAM, displayName: 'Ram Thapa', role: 'Head · Sales', salesHead: true },
  { userId: GITA, displayName: '' },
];

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

/** GET /v1/admin/settings/:key's DTO. The lead owner was never saved: its default, null, with version null. */
function settingDto(
  key: string,
  ownerValue: string | null = null,
  ownerVersion: number | null = null,
) {
  return key === OWNER_KEY
    ? { key, value: ownerValue, version: ownerVersion }
    : { key, value: SAVED[key], version: 4 };
}

beforeEach(() => {
  vi.clearAllMocks();
  admin.getSetting.mockImplementation((_session: unknown, key: string) =>
    Promise.resolve(settingDto(key)),
  );
  admin.listDefaultLeadOwnerPeople.mockResolvedValue(OWNERS);
});

describe('the delivery hold card', () => {
  it('shows the saved threshold as a money field to the Founder', async () => {
    persona('founder-live', ['sales'], 'admin.settings.write');
    const html = await render();
    expect(admin.getSetting).toHaveBeenCalledWith(expect.anything(), KEY);
    expect(html).toContain('Delivery holds');
    // The sales order release reads this threshold now, so the card says who the rule leaves out of it.
    expect(html).toContain(
      'The Founder may release any amount; the person who created the order never can.',
    );
    expect(html).toContain('Management releases holds above (NPR)');
    // The shared number input: before hydration the labelled box posts what it shows.
    const input = html.match(/<input[^>]*name="v:sales\.delivery_hold\.management_npr"[^>]*>/)?.[0];
    expect(input).toBeDefined();
    expect(input).toContain('type="text"');
    expect(input).toContain('value="250000.50"');
    expect(html).not.toContain('type="number"');
    const labelFor = html.match(
      /<label[^>]*for="([^"]+)"[^>]*>Management releases holds above \(NPR\)<\/label>/,
    )?.[1];
    expect(labelFor).toBeDefined();
    const box = html.match(new RegExp(`<input[^>]*id="${labelFor}"[^>]*>`))?.[0] ?? '';
    expect(box).toContain('type="text"');
    // Decimal keyboard: the 0.01 step allows two decimals.
    expect(box).toContain('inputMode="decimal"');
    expect(box).toContain('value="250000.50"');
    // Until hydration the box carries the name; a hidden input takes over after.
    expect(box).toContain('name="v:sales.delivery_hold.management_npr"');
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

describe('the lead owner card (F1-Q21)', () => {
  /** The owner field's markup, from its wrapper to the end of its card. */
  const ownerField = (html: string) => {
    const start = html.indexOf('data-setting="crm.default_lead_owner"');
    expect(start).toBeGreaterThan(-1);
    return html.slice(start, html.indexOf('</section>', start));
  };
  /** What the form submits for the key: the picker's named hidden field. */
  const submitted = (field: string) =>
    field.match(/<input type="hidden" name="v:crm\.default_lead_owner" value="([^"]*)"/)?.[1];
  /** What the closed member picker reads: name, then role. */
  const shown = (field: string) => field.match(/role="combobox"[^>]*? value="([^"]*)"/)?.[1];

  it('offers the people a new lead may fall back to, with the Sales head first, to the Founder', async () => {
    persona('founder-live', ['sales'], 'admin.settings.write');
    const html = await render();
    // The settings-scoped list (R4a Q10), never the lead owner route, which needs lead write.
    expect(admin.listDefaultLeadOwnerPeople).toHaveBeenCalledTimes(1);
    expect(crm.listLeadOwners).not.toHaveBeenCalled();
    expect(admin.getSetting).toHaveBeenCalledWith(expect.anything(), OWNER_KEY);
    expect(html).toContain('Lead owner');
    expect(html).toContain('Default owner');
    expect(html).toContain(
      'New leads that have no owner of their own, such as website leads, go to this person.',
    );
    const field = ownerField(html);
    expect(field).not.toContain('example.test');
    // Nothing chosen: the box names the Sales head, by name and role, never "Sales head (default)"...
    expect(shown(field)).toBe('Ram Thapa Head · Sales');
    expect(field).not.toContain('Sales head (default)');
    // ...while the form still posts nothing, so the API keeps storing null for "follow the Sales head".
    expect(submitted(field)).toBe('');
    // And the hint says where that default comes from.
    expect(field).toContain('Nobody chosen, so the Sales head, shown here, gets them.');
  });

  it('shows the saved person as chosen', async () => {
    persona('founder-live', ['sales'], 'admin.settings.write');
    admin.getSetting.mockImplementation((_session: unknown, key: string) =>
      Promise.resolve(settingDto(key, RAM, 2)),
    );
    const field = ownerField(await render());
    expect(shown(field)).toBe('Ram Thapa Head · Sales');
    expect(submitted(field)).toBe(RAM);
  });

  it('keeps a saved person the list no longer holds, so the field does not claim the Sales head', async () => {
    persona('founder-live', ['sales'], 'admin.settings.write');
    const gone = 'c0ffee00-0000-4000-8000-000000000009';
    admin.getSetting.mockImplementation((_session: unknown, key: string) =>
      Promise.resolve(settingDto(key, gone, 3)),
    );
    const field = ownerField(await render());
    expect(submitted(field)).toBe(gone);
    expect(shown(field)).toBe('Unavailable person (Sales head is used)');
  });

  it('costs only its own card when the people cannot be read', async () => {
    persona('founder-live', ['sales'], 'admin.settings.write');
    admin.listDefaultLeadOwnerPeople.mockRejectedValue(new Error('down'));
    const html = await render();
    expect(html).not.toContain('Default owner');
    expect(html).toContain('Quotation validity (days)');
    expect(html).toContain('Management releases holds above (NPR)');
  });

  it('is not shown to a finance-settings grant: the API keeps this key with admin.settings.write', async () => {
    persona('accountant-live', ['accountant'], 'settings.finance.write');
    await expect(render()).rejects.toThrow('REDIRECT:/settings/terms');
    expect(admin.listDefaultLeadOwnerPeople).not.toHaveBeenCalled();
  });

  it('works for a role holding admin.settings.write and no lead access', async () => {
    // A built-in role the tenant edited to settings only; the API side of this case is
    // apps/api/src/platform/settings/lead-owner-people.integration.test.ts.
    persona('settings-only-live', ['warehouse'], 'admin.settings.write');
    const field = ownerField(await render());
    expect(crm.listLeadOwners).not.toHaveBeenCalled();
    expect(admin.listDefaultLeadOwnerPeople).toHaveBeenCalledTimes(1);
    expect(shown(field)).toBe('Ram Thapa Head · Sales');
  });
});

describe('saving the default lead owner', () => {
  it('writes the picked user id with the loaded version for the Founder', async () => {
    persona('founder-live', ['sales'], 'admin.settings.write');
    admin.putSetting.mockResolvedValue({ version: 1 });
    const result = await saveSettingsPageAction('sales', [
      { key: OWNER_KEY, value: { kind: 'text', value: RAM }, expectedVersion: null },
    ]);
    expect(result).toMatchObject({ status: 'ok', saved: [{ key: OWNER_KEY, version: 1 }] });
    expect(admin.putSetting).toHaveBeenCalledWith(expect.anything(), OWNER_KEY, RAM, null);
  });

  it('writes null for the Sales head choice', async () => {
    persona('founder-live', ['sales'], 'admin.settings.write');
    admin.putSetting.mockResolvedValue({ version: 3 });
    await expect(
      saveSettingsPageAction('sales', [
        { key: OWNER_KEY, value: { kind: 'text', value: '' }, expectedVersion: 2 },
      ]),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(admin.putSetting).toHaveBeenCalledWith(expect.anything(), OWNER_KEY, null, 2);
  });

  it('refuses a value that is not a user id next to the field, before any write', async () => {
    persona('founder-live', ['sales'], 'admin.settings.write');
    const result = await saveSettingsPageAction('sales', [
      { key: OWNER_KEY, value: { kind: 'text', value: 'Ram Thapa' }, expectedVersion: 2 },
    ]);
    expect(result.status).toBe('error');
    expect(result.fieldErrors[OWNER_KEY]).toBe('Choose a person from the list.');
    expect(admin.putSetting).not.toHaveBeenCalled();
  });

  it('refuses a finance-settings grant before any write', async () => {
    persona('accountant-live', ['accountant'], 'settings.finance.write');
    await expect(
      saveSettingsPageAction('sales', [
        { key: OWNER_KEY, value: { kind: 'text', value: RAM }, expectedVersion: null },
      ]),
    ).rejects.toThrow('REDIRECT:');
    expect(admin.putSetting).not.toHaveBeenCalled();
  });
});
