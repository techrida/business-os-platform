import { EMPTY_COMPANY_PROFILE } from '@bos/contracts';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  usePathname: () => '/settings/company',
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const getSetting =
  vi.fn<
    (
      session: unknown,
      key: string,
    ) => Promise<{ key: string; value: unknown; version: number | null }>
  >();
vi.mock('@/lib/api-admin', () => ({
  getSetting: (session: unknown, key: string) => getSetting(session, key),
  putSetting: vi.fn(),
}));

const { default: CompanyPage } = await import('./page');
const { default: FormatsPage } = await import('../formats/page');

const session = (roles: string[]): Session =>
  ({ accessToken: 't', orgKind: 'staff', roles }) as Session;
const render = (el: unknown) => renderToStaticMarkup(el as ReactElement);

beforeEach(() => {
  getSession.mockReset();
  getSetting.mockReset().mockImplementation((_s, key) =>
    Promise.resolve({
      key,
      version: null,
      value:
        key === 'entity.profile'
          ? EMPTY_COMPANY_PROFILE
          : key === 'format.number_system'
            ? 'south_asian'
            : null,
    }),
  );
});

describe('Company profile and Number format pages', () => {
  it('redirect a sales user to the no-access page and read nothing', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(CompanyPage()).rejects.toThrow('REDIRECT:/no-access');
    await expect(FormatsPage()).rejects.toThrow('REDIRECT:/no-access');
    expect(getSetting).not.toHaveBeenCalled();
  });

  it('send a signed-out visitor to sign in, returning to the section', async () => {
    getSession.mockResolvedValue(null);
    await expect(CompanyPage()).rejects.toThrow(
      'REDIRECT:/auth/login?returnTo=%2Fsettings%2Fcompany',
    );
    await expect(FormatsPage()).rejects.toThrow(
      'REDIRECT:/auth/login?returnTo=%2Fsettings%2Fformats',
    );
  });

  it('show the founder the company cards, the empty-address helper and the preview', async () => {
    getSession.mockResolvedValue(session(['founder']));
    const html = render(await CompanyPage());
    for (const heading of [
      'Identity',
      'Address',
      'Contact',
      'Logo',
      'Authorised signatory',
      'Letterhead preview',
    ]) {
      expect(html).toContain(heading);
    }
    expect(html).toContain(
      'Quotations and invoices cannot be made into PDFs until an address is saved.',
    );
    expect(html).toContain('PNG, JPEG or WebP, up to 200 KB');
    expect(html).toContain('Address not set');
    expect(html).not.toContain('entity.');
    // every card but the logo has a Save, disabled while nothing changed
    expect((html.match(/<button[^>]*disabled=""[^>]*>Save<\/button>/g) ?? []).length).toBe(4);
  });

  it('show the founder both number systems with their worked examples and the fixed facts', async () => {
    getSession.mockResolvedValue(session(['founder']));
    const html = render(await FormatsPage());
    expect(html).toContain('NPR 20,18,180.00');
    expect(html).toContain('Twenty Lakh Eighteen Thousand One Hundred Eighty Rupees Only');
    expect(html).toContain('NPR 2,018,180.00');
    expect(html).toContain('Two Million Eighteen Thousand One Hundred Eighty Rupees Only');
    expect(html).toContain('Asia/Kathmandu');
    expect(html).not.toContain('Date format');
  });

  it('show one notice when a read is refused, not a half-filled form', async () => {
    getSession.mockResolvedValue(session(['founder']));
    getSetting.mockRejectedValue(Object.assign(new Error('no'), { status: 403 }));
    const html = render(await CompanyPage());
    expect(html).toContain('You don&#x27;t have permission to view the company profile.');
    expect(html).not.toContain('Letterhead preview');
  });
});
