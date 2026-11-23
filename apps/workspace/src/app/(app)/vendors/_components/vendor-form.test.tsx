import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { EMPTY_VENDOR_VALUES } from '../_lib/forms';
import { VendorForm } from './vendor-form';

const action = vi.fn();
const ID = '11111111-1111-4111-8111-111111111111';

/** The field names the form submits; the Select also renders a hidden native copy of its own, so names are unique'd. */
const names = (out: string) =>
  [...new Set([...out.matchAll(/ name="([^"]+)"/g)].map((m) => m[1]))].sort();

const create = () =>
  renderToStaticMarkup(
    <VendorForm
      title="Add vendor"
      description="Starts as a draft."
      action={action}
      mode="create"
      initial={EMPTY_VENDOR_VALUES}
      idempotencyKey="key-1"
      cancelHref="/vendors"
      reloadHref="/vendors/new"
    />,
  );

const edit = (kind: 'company' | 'foreign' = 'company') =>
  renderToStaticMarkup(
    <VendorForm
      title="Edit vendor"
      description="Himal Traders"
      action={action}
      mode="edit"
      initial={{ ...EMPTY_VENDOR_VALUES, legalName: 'Himal Traders', kind, pan: '301234567' }}
      vendorId={ID}
      version={3}
      cancelHref={`/vendors/${ID}`}
      reloadHref={`/vendors/${ID}/edit`}
    />,
  );

describe('vendor form', () => {
  it('puts the title, then Cancel before the submit button, at the top of the form', () => {
    const out = create();
    const h1 = out.indexOf('<h1');
    const cancel = out.indexOf('>Cancel<');
    const submit = out.indexOf('>Add vendor</button>');
    expect(h1).toBeGreaterThan(-1);
    expect(cancel).toBeGreaterThan(h1);
    expect(submit).toBeGreaterThan(cancel);
    // Before the first field.
    expect(submit).toBeLessThan(out.indexOf('name="legalName"'));
    // One live region however many copies of the buttons there are, plus the PAN box's own status line and the
    // Country picker's results count.
    expect(out.match(/role="status"/g)).toHaveLength(3);
  });

  it('create submits the vendor fields and the address, under numbered section eyebrows', () => {
    const out = create();
    expect(names(out)).toEqual(
      [
        'address.city',
        'address.country',
        'address.line',
        'idempotencyKey',
        'kind',
        'legalName',
        'pan',
        'tradeName',
        'vatRegistered',
      ].sort(),
    );
    expect(out).toContain('aria-hidden="true">01 · The basics</span>');
    expect(out).toContain('aria-hidden="true">02 · Tax registration</span>');
    expect(out).toContain('aria-hidden="true">03 · Address</span>');
    // The country is asked once, as the address's Country.
    expect(out.match(/name="address\.country"/g)).toHaveLength(1);
    expect(out).not.toContain('name="country"');
  });

  it('edit keeps the editable fields in a details card and an address card, the country fixed', () => {
    const out = edit();
    expect(names(out)).toEqual(
      [
        'address.city',
        'address.line',
        'expectedVersion',
        'legalName',
        'pan',
        'vatRegistered',
        'vendorId',
      ].sort(),
    );
    expect(out.match(/<section/g)).toHaveLength(2);
    expect(out).toContain('>Save changes</button>');
    expect(out).toContain('value="Nepal"');
    expect(out).toContain('Fixed once the vendor is added.');
  });

  it('edit of a foreign vendor offers an optional Tax ID instead of the nine-digit PAN', () => {
    const out = edit('foreign');
    expect(names(out)).toContain('pan');
    expect(out).toContain('>Tax ID</label><span');
    expect(out).toContain('>Optional</span>');
    expect(out).not.toContain('Tax ID (optional)');
    expect(out).not.toContain('>PAN<');
  });

  it('marks optional fields beside the label and shows examples instead of format hints (UIP-FORM-008)', () => {
    const out = create();
    expect(out).not.toContain('(optional)');
    expect(out).not.toContain('Optional.');
    expect(out).not.toContain('Nine digits');
    expect(out).toContain('placeholder="123456789"');
    // Trade name, Address and City each carry the marker; PAN, Legal name, Kind and Country do not.
    expect(out.match(/>Optional<\/span>/g)).toHaveLength(3);
    expect(out).toContain('>Trade name</label><span');
  });
});
