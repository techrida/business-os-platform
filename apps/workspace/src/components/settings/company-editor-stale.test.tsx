// @vitest-environment jsdom
import { EMPTY_COMPANY_PROFILE } from '@bos/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm, submit } from '@/test/form-interactions';

// The real Save action runs against a mocked settings API, so the editor sees exactly what the
// action hands back on a stale save (the plain message, and the Identity card's half-saved one).
vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const refresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast }));
vi.mock('@/app/(app)/settings/guard', () => ({
  requireSection: () => Promise.resolve({ accessToken: 't' }),
}));
const getSetting = vi.hoisted(() => vi.fn());
const putSetting = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api-admin', () => ({ getSetting, putSetting }));

const { saveCompanyCardAction, resetCompanyCardAction } =
  await import('@/app/(app)/settings/company/actions');
const { CompanyEditor } = await import('./company-editor');
const { STALE_SETTING_MESSAGE } = await import('./stale-setting');

const PARTIAL =
  'The display name was saved, but the PAN or VAT number was changed by someone else. Reload to see the latest.';

const profile = { ...EMPTY_COMPANY_PROFILE, displayName: 'Acme' };
const values: Record<string, unknown> = {
  'entity.profile': profile,
  'entity.address': null,
  'entity.pan_vat_no': null,
};
const staleError = () =>
  Object.assign(new Error('conflict'), {
    status: 409,
    body: { error: { code: 'stale_setting', message: 'api text', correlationId: 'c1' } },
  });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  refresh.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  getSetting
    .mockReset()
    .mockImplementation((_session: unknown, key: string) =>
      Promise.resolve({ key, value: values[key] ?? null, version: 1 }),
    );
  putSetting.mockReset();
});

const mountEditor = () =>
  mountForm(
    <CompanyEditor
      organisationId="22222222-2222-4222-8222-222222222222"
      settings={{ profile, address: null, panVatNo: null }}
      versions={{ 'entity.profile': 3, 'entity.address': null, 'entity.pan_vat_no': 5 }}
      action={saveCompanyCardAction}
      resetCard={resetCompanyCardAction}
    />,
  );

const occurrences = (text: string, part: string) => text.split(part).length - 1;

/** The Identity card: the first card on the screen. */
const identityCard = (container: HTMLElement) => {
  const form = container.querySelector('form');
  if (!form) throw new Error('Missing Identity form');
  return form;
};

const buttonNamed = (root: Element, name: string) =>
  Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === name) ?? null;

describe('CompanyEditor stale save', () => {
  it('shows the reload notice once, with a Reload button, when the save lost a race', async () => {
    putSetting.mockRejectedValue(staleError());
    const mounted = await mountEditor();
    const form = identityCard(mounted.container);
    await fill(form.querySelector('input[name="displayName"]'), 'Acme Pvt');
    await submit(mounted.container);

    const text = form.textContent ?? '';
    expect(occurrences(text, STALE_SETTING_MESSAGE)).toBe(1);
    const reload = buttonNamed(form, 'Reload');
    expect(reload).not.toBeNull();
    await click(reload);
    expect(refresh).toHaveBeenCalledOnce();
    await mounted.unmount();
  });

  it('shows the Identity card half-saved message with a Reload button', async () => {
    putSetting.mockResolvedValueOnce({ version: 4 }).mockRejectedValueOnce(staleError());
    const mounted = await mountEditor();
    const form = identityCard(mounted.container);
    await fill(form.querySelector('input[name="displayName"]'), 'Acme Pvt');
    await fill(form.querySelector('input[name="panVatNo"]'), '123456789');
    await submit(mounted.container);

    expect(putSetting).toHaveBeenCalledTimes(2);
    const text = form.textContent ?? '';
    expect(occurrences(text, PARTIAL)).toBe(1);
    expect(text).not.toContain(STALE_SETTING_MESSAGE);
    expect(buttonNamed(form, 'Reload')).not.toBeNull();
    await mounted.unmount();
  });
});
