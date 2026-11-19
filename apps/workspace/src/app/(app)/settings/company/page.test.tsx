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
      value: key === 'entity.profile' ? EMPTY_COMPANY_PROFILE : null,
    }),
  );
});

describe('Company profile and Number format pages', () => {
  it('redirect a sales user to the no-access page and read nothing', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(CompanyPage()).rejects.toThrow('REDIRECT:/settings/denied');
    await expect(FormatsPage()).rejects.toThrow('REDIRECT:/settings/denied');
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
    // Setting keys travel in hidden fields, never as text a person reads.
    expect(html).not.toMatch(/>[^<]*entity\./);
    // every card but the logo has a Save, disabled while nothing changed
    expect((html.match(/<button[^>]*disabled=""[^>]*>Save<\/button>/g) ?? []).length).toBe(4);
  });

  it('draws no undo icon while the address, contact and signatory are empty', async () => {
    getSession.mockResolvedValue(session(['founder']));
    const html = render(await CompanyPage());
    expect(html).not.toContain('to default');
  });

  it('draws an undo icon on each card whose saved fields are not empty', async () => {
    getSession.mockResolvedValue(session(['founder']));
    getSetting.mockImplementation((_s, key) =>
      Promise.resolve({
        key,
        version: 4,
        value:
          key === 'entity.profile'
            ? { ...EMPTY_COMPANY_PROFILE, phones: ['01-4000000'], signatoryName: 'Sita' }
            : key === 'entity.address'
              ? { line1: 'Durbar Marg', city: 'Kathmandu', country: 'NP' }
              : null,
      }),
    );
    const html = render(await CompanyPage());
    for (const label of ['Address', 'Contact details', 'Authorised signatory']) {
      expect(html).toContain(`aria-label="Reset ${label} to default"`);
    }
  });

  it('puts the version each setting was loaded at into the forms, and nothing for a default', async () => {
    getSession.mockResolvedValue(session(['founder']));
    getSetting.mockImplementation((_s, key) =>
      Promise.resolve({
        key,
        value: key === 'entity.profile' ? EMPTY_COMPANY_PROFILE : null,
        version: key === 'entity.profile' ? 4 : key === 'entity.address' ? 2 : null,
      }),
    );
    const html = render(await CompanyPage());
    const field = (key: string) =>
      html.match(
        new RegExp(`name="expectedVersion:${key.replace('.', '\\.')}" value="([^"]*)"`, 'g'),
      );
    // Identity, Contact and Signatory write the profile; Identity also writes the PAN or VAT number.
    expect(field('entity.profile')).toEqual(Array(3).fill(expect.stringContaining('value="4"')));
    expect(field('entity.address')).toEqual([expect.stringContaining('value="2"')]);
    expect(field('entity.pan_vat_no')).toEqual([expect.stringContaining('value=""')]);
  });

  it('show the founder a number system per currency with worked examples, the date format and the fixed facts', async () => {
    getSession.mockResolvedValue(session(['founder']));
    const html = render(await FormatsPage());
    expect(html).toContain('NPR 20,18,180.00');
    expect(html).toContain('Twenty Lakh Eighteen Thousand One Hundred Eighty Rupees Only');
    // USD defaults to International, so its row shows the million wording.
    expect(html).toContain('USD 2,018,180.00');
    expect(html).toContain('Two Million Eighteen Thousand One Hundred Eighty Dollars Only');
    expect(html).toContain('Asia/Kathmandu');
    expect(html).toContain('Date format');
  });

  it('show one notice when a read is refused, not a half-filled form', async () => {
    getSession.mockResolvedValue(session(['founder']));
    getSetting.mockRejectedValue(Object.assign(new Error('no'), { status: 403 }));
    const html = render(await CompanyPage());
    expect(html).toContain('You don&#x27;t have permission to view the company profile.');
    expect(html).not.toContain('Letterhead preview');
  });
});
