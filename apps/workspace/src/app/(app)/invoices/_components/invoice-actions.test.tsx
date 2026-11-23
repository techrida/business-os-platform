import type { ReactNode } from 'react';
import {
  InvoiceCanSchema,
  type InvoiceCan,
  type InvoiceKind,
  type InvoiceStatus,
} from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { permissionChecker } from '@/components/p2/customers/permissions';

import { invoiceGates } from '../_lib/gates';
import { ID } from '../_lib/test-fixtures';

import { InvoiceActions } from './invoice-actions';

// The dialogs import the server actions, which import server-only modules.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: vi.fn() }));
// Radix mounts its portal only when a browser opens it. Keep the footer separate while
// rendering the producer's form data and button wiring in this server-rendered test.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({
    trigger,
    title,
    description,
    children,
    footer,
  }: Record<'trigger' | 'title' | 'description' | 'children' | 'footer', ReactNode>) => (
    <>
      {trigger}
      <section>
        <h2>{title}</h2>
        <p>{description}</p>
        {children}
        <footer>{footer}</footer>
      </section>
    </>
  ),
  DialogClose: ({ children }: { children: ReactNode }) => children,
}));

function render(
  kind: InvoiceKind,
  status: InvoiceStatus,
  roles: string[],
  number: string | null = null,
): string {
  const invoice = { id: ID, kind, status, number, version: 7, dueDate: null, salesOrderId: null };
  return renderToStaticMarkup(
    <InvoiceActions
      invoice={invoice}
      gates={invoiceGates(invoice, permissionChecker(roles))}
      reloadHref={`/invoices/${ID}`}
    />,
  );
}

const triggers = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>(Submit for approval|Issue [a-z ]+|Discard)<\/button>/g)].map(
    (m) => m[1] ?? '',
  );
const unique = (list: string[]) => [...new Set(list)];

describe('which actions an invoice offers', () => {
  const both = ['accountant', 'finance'];
  const cases: [InvoiceKind, InvoiceStatus, string[], string[]][] = [
    ['tax_invoice', 'draft', both, ['Submit for approval', 'Discard']],
    ['tax_invoice', 'submitted', both, []],
    ['tax_invoice', 'returned', both, ['Submit for approval', 'Discard']],
    ['tax_invoice', 'approved', both, ['Issue tax invoice']],
    ['tax_invoice', 'issued', both, []],
    ['tax_invoice', 'discarded', both, []],
    ['proforma', 'draft', both, ['Issue proforma', 'Discard']],
    ['proforma', 'issued', both, []],
    ['credit_note', 'approved', both, ['Issue credit note']],
    ['debit_note', 'draft', both, ['Submit for approval', 'Discard']],
  ];
  it.each(cases)('%s %s offers %j', (kind, status, roles, expected) => {
    expect(unique(triggers(render(kind, status, roles)))).toEqual(expected);
  });

  it('shows an Accountant no Issue button, and a read-only role no action at all', () => {
    expect(unique(triggers(render('tax_invoice', 'approved', ['accountant'])))).toEqual([]);
    expect(unique(triggers(render('tax_invoice', 'draft', ['management'])))).toEqual([]);
  });

  it('renders nothing at all when no action applies, so the slot stays empty', () => {
    expect(render('tax_invoice', 'issued', both)).toBe('');
    expect(render('tax_invoice', 'draft', ['sales'])).toBe('');
  });
});

describe('the forms', () => {
  const html = render('tax_invoice', 'draft', ['accountant'], 'INV-2083/84-00009');

  it('send the version the person looked at and one distinct key per action', () => {
    expect(html.match(/name="expectedVersion" value="7"/g)).toHaveLength(2);
    const keys = [...html.matchAll(/name="idempotencyKey" value="([^"]+)"/g)].map((m) => m[1]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    for (const k of keys) expect(k).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('name the invoice in each dialog, and say why a reason is needed to discard', () => {
    expect(html).toContain('Submit INV-2083/84-00009');
    expect(html).toContain('Discard INV-2083/84-00009');
    expect(html).toContain('name="reason"');
    expect(html).toContain('cannot be brought back');
    const ids = [...html.matchAll(/<form id="([^"]+)"/g)].map((match) => match[1]);
    expect(ids).toHaveLength(2);
    for (const id of ids) {
      expect(html).toContain(`</form><footer>`);
      expect(html).toContain(`form="${id}"`);
    }
  });

  it('say that issuing sets the number and date, which cannot be changed', () => {
    const approved = render('tax_invoice', 'approved', ['finance']);
    expect(approved).toMatch(/number and today/i);
    expect(approved).toMatch(/neither can be changed/i);
  });

  it('name an unnumbered draft by its kind', () => {
    expect(render('proforma', 'draft', ['finance'])).toContain('Issue proforma');
  });
});

describe('a note its viewer created (TR-Q12f)', () => {
  const invoice = {
    id: ID,
    kind: 'debit_note' as const,
    status: 'approved' as const,
    number: null,
    version: 7,
    dueDate: null,
    salesOrderId: '8d0c1f2e-4b5a-4c6d-9e7f-0a1b2c3d4e5f',
  };
  const html = renderToStaticMarkup(
    <InvoiceActions
      invoice={invoice}
      gates={invoiceGates(invoice, permissionChecker(['finance']), true)}
      reloadHref={`/invoices/${ID}`}
    />,
  );

  it('shows Issue off, with the reason only in its tooltip (UIP-FORM-011), and no issue form', () => {
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Issue debit note<\/button>/);
    // No caption beside the button, and never a native title bubble; the reason opens in the Tooltip
    // (blocked-action-tooltips.test.tsx drives that).
    expect(html).not.toContain('You created this note');
    expect(html).not.toMatch(/<button[^>]* title=/);
    // The only form is Back to draft (the creator may still take their approved note back); no issue form.
    expect(html).not.toContain('<h2>Issue ');
    expect(html.match(/name="idempotencyKey"/g)).toHaveLength(1);
    expect(html).toContain('<h2>Move debit note back to draft</h2>');
  });
});

// The detail's `can`, through the contract, with the API's own words (invoice-mapping.ts `dueDateEditRefusal`).
const ORDER_REASON =
  "This invoice's due date is set when it is issued, from the sales order's credit days";
const ORDER_ID = '8d0c1f2e-4b5a-4c6d-9e7f-0a1b2c3d4e5f';

function detailCan(editDueDate: InvoiceCan['editDueDate'], over: Partial<InvoiceCan> = {}) {
  return InvoiceCanSchema.parse({
    submit: true,
    issue: true,
    discard: true,
    notes: true,
    recordPayment: false,
    editDueDate,
    ...over,
  });
}

function renderDetail(
  over: {
    kind?: InvoiceKind;
    status?: InvoiceStatus;
    dueDate?: string | null;
    salesOrderId?: string | null;
    can?: InvoiceCan;
  },
  roles: string[] = ['accountant'],
): string {
  const invoice = {
    id: ID,
    kind: over.kind ?? ('tax_invoice' as const),
    status: over.status ?? ('draft' as const),
    number: null,
    version: 7,
    dueDate: over.dueDate ?? null,
    salesOrderId: over.salesOrderId ?? null,
  };
  return renderToStaticMarkup(
    <InvoiceActions
      invoice={invoice}
      gates={invoiceGates({ ...invoice, can: over.can }, permissionChecker(roles))}
      reloadHref={`/invoices/${ID}`}
    />,
  );
}

describe('Edit due date', () => {
  it('opens a date dialog on a draft that shows the current due date in AD and BS and sends the version', () => {
    const html = renderDetail({ dueDate: '2026-11-30', can: detailCan({ allowed: true }) });
    expect(html).toMatch(/<button[^>]*>Edit due date<\/button>/);
    expect(html).toContain('<h2>Edit the due date of tax invoice</h2>');
    expect(html).toContain('The due date is now 30 Nov 2026 (');
    expect(html).toMatch(/\d{1,2} [A-Z][a-z]+ 208\d BS\)\./);
    expect(html).toMatch(
      /name="dueDate"[^>]*value="2026-11-30"|value="2026-11-30"[^>]*name="dueDate"/,
    );
    // Submit, Edit due date and Discard each carry their own form, version and key.
    expect(html.match(/name="expectedVersion" value="7"/g)).toHaveLength(3);
    const keys = [...html.matchAll(/name="idempotencyKey" value="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(keys).size).toBe(3);
    expect(html).toContain('Save due date');
  });

  it('offers it on a returned invoice too', () => {
    const html = renderDetail({ status: 'returned', can: detailCan({ allowed: true }) });
    expect(html).toMatch(/<button[^>]*>Edit due date<\/button>/);
    expect(html).toContain('This invoice has no due date yet.');
  });

  it("shows an order's invoice the button off, with the API's reason in its tooltip only", () => {
    const html = renderDetail({
      salesOrderId: ORDER_ID,
      can: detailCan({ allowed: false, reason: ORDER_REASON }),
    });
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Edit due date<\/button>/);
    // UIP-FORM-011: the reason is the Tooltip's, not text under the button.
    expect(html).not.toContain(ORDER_REASON.slice(0, 30));
    expect(html).not.toMatch(/<button[^>]* title=/);
    expect(html).not.toContain('name="dueDate"');
  });

  it('is not offered outside draft and returned, without the draft grant, or when the grant does not reach', () => {
    const allowed = detailCan({ allowed: true });
    expect(renderDetail({ status: 'submitted', can: allowed })).not.toContain('Edit due date');
    expect(renderDetail({ status: 'issued', can: allowed })).not.toContain('Edit due date');
    expect(renderDetail({ can: allowed }, ['management'])).not.toContain('Edit due date');
    expect(
      renderDetail({ can: detailCan({ allowed: false, reason: 'x' }, { discard: false }) }),
    ).not.toContain('Edit due date');
    // A list row or an older API sends no `editDueDate`: nothing to go on, so no button.
    expect(renderDetail({ can: detailCan(undefined) })).not.toContain('Edit due date');
  });
});

describe('Back to draft says what happens to the approval and the due date', () => {
  const words = (html: string) => /<h2>Move [^<]+<\/h2><p>([^<]+)<\/p>/.exec(html)?.[1] ?? '';

  it('a manual tax invoice: the approval no longer counts, its due date can be changed, then submit again', () => {
    const text = words(renderDetail({ status: 'approved' }, ['finance']));
    expect(text).toMatch(/approval will no longer count/);
    expect(text).toMatch(/due date can be changed/);
    expect(text).toMatch(/submitted for approval again before it is issued/);
    expect(text).not.toMatch(/approved again/);
  });

  it("an order's invoice and a debit note: their due date is set at issue, not edited", () => {
    for (const html of [
      renderDetail({ status: 'approved', salesOrderId: ORDER_ID }, ['finance']),
      renderDetail({ status: 'approved', kind: 'debit_note' }, ['finance']),
    ]) {
      const text = words(html);
      expect(text).toMatch(/due date is set when it is issued/);
      expect(text).not.toMatch(/can be changed/);
      expect(text).toMatch(/submitted for approval again/);
    }
  });

  it('a credit note: nothing about a due date', () => {
    const text = words(renderDetail({ status: 'approved', kind: 'credit_note' }, ['finance']));
    expect(text).toMatch(/submitted for approval again/);
    expect(text).not.toMatch(/due date/);
  });
});
