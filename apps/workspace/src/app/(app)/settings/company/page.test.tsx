import { EMPTY_COMPANY_PROFILE, IMAGE_HINT } from '@bos/contracts';
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
  useRouter: () => ({ refresh: vi.fn() }),
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

const ORG_ID = '0190a1b2-0000-7000-8000-00000000a001';
const DOC_ID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const session = (roles: string[]): Session =>
  ({ accessToken: 't', orgId: ORG_ID, orgKind: 'staff', roles }) as Session;
const withProfile = (profile: object) =>
  getSetting.mockImplementation((_s, key) =>
    Promise.resolve({
      key,
      version: 4,
      value: key === 'entity.profile' ? { ...EMPTY_COMPANY_PROFILE, ...profile } : null,
    }),
  );
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
    // The logo card is the shared upload box for the organisation: no Save, no logo form.
    expect(html).toContain(IMAGE_HINT);
    expect(html).toContain('aria-label="Logo"');
    expect(html).toContain(
      'Printed at the top of your quotations, invoices, purchase orders and memos.',
    );
    expect(html).not.toContain('name="logo"');
    expect(html).not.toContain('value="logo"');
    expect(html).toContain('Address not set');
    // Setting keys travel in hidden fields, never as text a person reads.
    expect(html).not.toMatch(/>[^<]*entity\./);
    // every card but the logo has a Save, disabled while nothing changed
    expect((html.match(/<button[^>]*disabled=""[^>]*>Save<\/button>/g) ?? []).length).toBe(4);
  });

  it('shows an uploaded logo through the image route, in the card and on the letterhead', async () => {
    getSession.mockResolvedValue(session(['founder']));
    withProfile({ displayName: 'Acme', logoDocumentId: DOC_ID, legacyLogoDataUrl: PNG });
    const html = render(await CompanyPage());
    expect(html).toContain(`src="/api/images/${DOC_ID}"`);
    expect(html).toContain('aria-label="Remove Acme picture"');
    // The document wins: the old data URL is neither drawn nor mentioned.
    expect(html).not.toContain(PNG);
    expect(html).not.toContain('still prints');
  });

  describe('the three logo slots', () => {
    const DARK_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const LIGHT_ID = 'ffffffff-0000-4111-8222-333333333333';

    it('has Logo, Logo for dark backgrounds and Logo for light backgrounds, the last two marked Optional', async () => {
      getSession.mockResolvedValue(session(['founder']));
      const html = render(await CompanyPage());
      for (const title of ['Logo', 'Logo for dark backgrounds', 'Logo for light backgrounds']) {
        expect(html).toContain(`aria-label="${title}"`);
      }
      // "Optional" is on the right end of the label row (UIP-FORM-008), for the two variants only.
      expect((html.match(/>Optional</g) ?? []).length).toBe(2);
    });

    it('shows the Business OS example in every empty slot, labelled as an example and said to be empty', async () => {
      getSession.mockResolvedValue(session(['founder']));
      withProfile({ displayName: 'Acme', logoDocumentId: DOC_ID });
      const html = render(await CompanyPage());
      // The main logo is uploaded: its two variants are empty and each shows an example on its own background.
      expect((html.match(/data-testid="logo-placeholder"/g) ?? []).length).toBe(2);
      expect(html).toContain('data-stage="dark"');
      expect(html).toContain('data-stage="light"');
      expect(html).toContain('>Example<');
      expect(html).toContain(
        'Logo for dark backgrounds: nothing uploaded. The Business OS logo shown is only an example.',
      );
      expect(html).toContain(
        'Logo for light backgrounds: nothing uploaded. The Business OS logo shown is only an example.',
      );
    });

    it('waits for a main logo before the variants can be uploaded', async () => {
      getSession.mockResolvedValue(session(['founder']));
      const html = render(await CompanyPage());
      expect(html).toContain('data-testid="logo-placeholder"');
      expect((html.match(/Upload the main logo first\./g) ?? []).length).toBe(2);
    });

    it('shows an uploaded variant through the image route, on its own background, and drops its example', async () => {
      getSession.mockResolvedValue(session(['founder']));
      withProfile({
        displayName: 'Acme',
        logoDocumentId: DOC_ID,
        logoOnDarkDocumentId: DARK_ID,
        logoOnLightDocumentId: LIGHT_ID,
      });
      const html = render(await CompanyPage());
      expect(html).toContain(`src="/api/images/${DARK_ID}"`);
      expect(html).toContain(`src="/api/images/${LIGHT_ID}"`);
      expect(html).toContain('aria-label="Remove Acme logo for dark backgrounds picture"');
      expect(html).not.toContain('data-testid="logo-placeholder"');
      expect(html).not.toContain('Upload the main logo first.');
    });
  });

  it('shows a logo not yet moved as a preview-only picture, with a note in the card description', async () => {
    getSession.mockResolvedValue(session(['founder']));
    withProfile({ displayName: 'Acme', legacyLogoDataUrl: PNG });
    const html = render(await CompanyPage());
    expect(html).toContain('aria-label="View Acme logo"');
    expect(html).toContain(`src="${PNG}"`);
    expect(html).toContain('Your current logo still prints while it is moved');
    // Nothing to remove until it is an uploaded image; the upload box replaces it.
    expect(html).not.toContain('aria-label="Remove Acme picture"');
    expect(html).toContain('Upload picture');
  });

  it('names the logo controls after the company, or "your company" with no display name', async () => {
    getSession.mockResolvedValue(session(['founder']));
    withProfile({ logoDocumentId: DOC_ID });
    const html = render(await CompanyPage());
    expect(html).toContain('aria-label="Remove your company picture"');
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
            ? {
                ...EMPTY_COMPANY_PROFILE,
                phones: [{ country: 'NP', e164: '+97714000000', label: null }],
                signatoryName: 'Sita',
              }
            : key === 'entity.address'
              ? { line: 'Durbar Marg', city: 'Kathmandu', country: 'NP' }
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
