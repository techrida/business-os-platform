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
    // One live region however many copies of the buttons there are, plus the PAN box's own status line.
    expect(out.match(/role="status"/g)).toHaveLength(2);
  });

  it('create submits the same fields as before, under numbered section eyebrows', () => {
    const out = create();
    expect(names(out)).toEqual(
      [
        'country',
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
  });

  it('edit keeps the editable fields together in one card', () => {
    const out = edit();
    expect(names(out)).toEqual(
      ['expectedVersion', 'legalName', 'pan', 'vatRegistered', 'vendorId'].sort(),
    );
    expect(out.match(/<section/g)).toHaveLength(1);
    expect(out).toContain('>Save changes</button>');
  });

  it('edit of a foreign vendor has no PAN, and the legal name takes the whole row', () => {
    const out = edit('foreign');
    expect(names(out)).not.toContain('pan');
    const field = out.slice(0, out.indexOf('name="legalName"'));
    expect(field.slice(field.lastIndexOf('<div class="'))).toMatch(/wide/);
  });
});
