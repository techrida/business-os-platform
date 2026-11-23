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

const edit = (kind: 'company' | 'foreign' = 'company', lockIdentity = false) =>
  renderToStaticMarkup(
    <VendorForm
      title="Edit vendor"
      description="Himal Traders"
      action={action}
      mode="edit"
      initial={{ ...EMPTY_VENDOR_VALUES, legalName: 'Himal Traders', kind, pan: '301234567' }}
      vendorId={ID}
      version={3}
      lockIdentity={lockIdentity}
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

  it('D10: edit asks for the kind and the country, as create does, in a details card and an address card', () => {
    const out = edit();
    expect(names(out)).toEqual(
      [
        'address.city',
        'address.country',
        'address.line',
        'expectedVersion',
        'kind',
        'legalName',
        'pan',
        'vatRegistered',
        'vendorId',
      ].sort(),
    );
    expect(out.match(/<section/g)).toHaveLength(2);
    expect(out).toContain('>Save changes</button>');
    expect(out).toContain('value="Nepal"');
    expect(out).not.toContain('Fixed once the vendor is added.');
    expect(out.match(/name="address\.country"/g)).toHaveLength(1);
  });

  it('D10: an approved vendor shows the kind and country locked, and posts neither', () => {
    const out = edit('company', true);
    expect(out).toContain(
      'Locked while the vendor is approved. A change goes through a new KYB review.',
    );
    // A disabled control posts nothing, so the locked kind and country are not read as a change.
    const hidden = (name: string) =>
      [...out.matchAll(/<input[^>]*>/g)]
        .map((m) => m[0])
        .filter((tag) => tag.includes(` name="${name}"`));
    for (const name of ['kind', 'address.country']) {
      expect(hidden(name).length).toBeGreaterThan(0);
      for (const tag of hidden(name)) expect(tag).toContain('disabled');
    }
    // The address itself stays editable.
    expect(names(out)).toContain('address.line');
  });

  it('edit of a foreign vendor offers an optional Tax ID instead of the nine-digit PAN', () => {
    const out = edit('foreign');
    expect(names(out)).toContain('pan');
    expect(out).toContain('Tax ID (optional)');
    expect(out).not.toContain('>PAN<');
  });
});
