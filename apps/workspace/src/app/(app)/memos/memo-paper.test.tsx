import {
  DEFAULT_BRAND_COLOUR,
  deriveBrandPalette,
  type MemoDirectory,
  type MemoTemplateSnapshot,
} from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { buildPreviewTemplate, initialTemplateFields } from './memo-form-model';
import { MemoPaper } from './memo-paper';

const ME = '11111111-1111-4111-8111-111111111111';
const DEPT = '44444444-4444-4444-8444-444444444444';
const ORG = '66666666-6666-4666-8666-666666666666';
// A 1x1 PNG: the shape LogoDataUrlSchema accepts.
const LOGO =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const signer = { userId: ME, name: 'Dev Sales', jobTitle: null, department: null };
/** A memo stored before letterheads: no `letterhead` key at all. */
const stored: MemoTemplateSnapshot = {
  organizationId: ORG,
  organizationName: 'Techrida Pvt. Ltd.',
  departmentId: DEPT,
  departmentName: 'General',
  date: '2026-11-18',
  closing: 'Submitted for your approval.',
  preparedBy: signer,
  recommenders: [],
  approvedBy: signer,
};
const letterhead = {
  addressLines: ['Kupondole, Lalitpur', 'Bagmati, Nepal 44600'],
  logoDataUrl: LOGO,
  primaryColour: '#15803d',
};

const render = (template: MemoTemplateSnapshot) =>
  renderToStaticMarkup(<MemoPaper template={template} title="Laptops" body="Body text" />);
/** The band's markup alone, so a match cannot come from the memo body or the signers. */
const bandOf = (html: string) => /<header[\s\S]*?<\/header>/.exec(html)?.[0] ?? '';
/** React writes inline colours as given (hex), so the palette's values appear verbatim. */
const styleWith = (prop: string, value: string) => `${prop}:${value}`;

describe('the memo letterhead band', () => {
  it('shows the large Memo title, then the company, the department and its address lines', () => {
    const band = bandOf(render({ ...stored, letterhead }));
    expect(band).toContain('>Memo</p>');
    expect(band).not.toContain('(MEMO)');
    expect(band).toContain('Techrida Pvt. Ltd.');
    expect(band).toContain('Kupondole, Lalitpur');
    expect(band).toContain('Bagmati, Nepal 44600');
    expect(band).toContain('General');
    // The PDF's order: company name, department, then the address lines.
    const name = band.indexOf('Techrida Pvt. Ltd.');
    const department = band.indexOf('General');
    const firstLine = band.indexOf('Kupondole, Lalitpur');
    expect(department).toBeGreaterThan(name);
    expect(firstLine).toBeGreaterThan(department);
    expect(band.indexOf('Bagmati, Nepal 44600')).toBeGreaterThan(firstLine);
  });

  it('draws the logo with the company name as its text alternative', () => {
    const band = bandOf(render({ ...stored, letterhead }));
    expect(band).toContain(`src="${LOGO}"`);
    expect(band).toContain('alt="Techrida Pvt. Ltd."');
  });

  it('has no image when the letterhead has no logo', () => {
    const band = bandOf(render({ ...stored, letterhead: { ...letterhead, logoDataUrl: null } }));
    expect(band).not.toContain('<img');
    expect(band).toContain('Kupondole, Lalitpur');
  });

  it('never draws a logo that fails the logo contract (SVG, remote URL)', () => {
    for (const bad of [
      'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
      'https://example.com/logo.png',
      'javascript:alert(1)',
    ]) {
      const html = render({ ...stored, letterhead: { ...letterhead, logoDataUrl: bad } });
      expect(html, bad).not.toContain('<img');
      expect(html, bad).not.toContain(bad);
    }
  });

  it('applies the brand palette: tint behind the band, accent colour on the title', () => {
    const palette = deriveBrandPalette('#15803d');
    const band = bandOf(render({ ...stored, letterhead }));
    expect(band).toContain(styleWith('background-color', palette.tint));
    expect(band).toContain(styleWith('color', palette.accentText));
  });

  it('a memo stored before letterheads still gets the band: title, company, department, default colour', () => {
    const palette = deriveBrandPalette(DEFAULT_BRAND_COLOUR);
    const band = bandOf(render(stored));
    expect(band).toContain('>Memo</p>');
    expect(band).toContain('Techrida Pvt. Ltd.');
    expect(band).toContain('General');
    expect(band).not.toContain('<img');
    expect(band).toContain(styleWith('background-color', palette.tint));
    expect(band).toContain(styleWith('color', palette.accentText));
  });

  it('falls back to the default colour when a stored colour is not a hex colour', () => {
    const palette = deriveBrandPalette(DEFAULT_BRAND_COLOUR);
    const band = bandOf(render({ ...stored, letterhead: { ...letterhead, primaryColour: 'red' } }));
    expect(band).toContain(styleWith('background-color', palette.tint));
  });

  it('leaves out blank address lines', () => {
    const band = bandOf(
      render({ ...stored, letterhead: { ...letterhead, addressLines: ['  ', 'Only line'] } }),
    );
    expect(band.match(/class="[^"]*bandLine/g) ?? []).toHaveLength(1);
  });
});

describe('where the band gets its letterhead', () => {
  const directory: MemoDirectory = {
    organizationId: ORG,
    organizationName: 'Techrida Pvt. Ltd.',
    currentUserId: ME,
    departmentId: DEPT,
    departments: [{ id: DEPT, name: 'General' }],
    people: [{ ...signer, canApprove: true }],
  };
  const fields = initialTemplateFields(null, directory, '2026-11-18');

  it('a draft shows the live letterhead from the directory', () => {
    const live = { ...directory, letterhead };
    expect(buildPreviewTemplate(live, null, fields, ME).letterhead).toEqual(letterhead);
    expect(bandOf(render(buildPreviewTemplate(live, null, fields, ME)))).toContain(`src="${LOGO}"`);
  });

  it('a returned memo shows the live letterhead, not the one frozen by its earlier submit', () => {
    const frozen = { ...letterhead, addressLines: ['Old address'], logoDataUrl: null };
    const live = { ...directory, letterhead };
    const preview = buildPreviewTemplate(live, { ...stored, letterhead: frozen }, fields, ME);
    expect(preview.letterhead).toEqual(letterhead);
  });

  it('without a live letterhead the draft has none, and the key is left out', () => {
    const preview = buildPreviewTemplate(directory, null, fields, ME);
    expect('letterhead' in preview).toBe(false);
  });

  it('a submitted memo renders its own frozen letterhead', () => {
    const frozen = { ...letterhead, addressLines: ['Frozen address'] };
    expect(bandOf(render({ ...stored, letterhead: frozen }))).toContain('Frozen address');
  });
});
