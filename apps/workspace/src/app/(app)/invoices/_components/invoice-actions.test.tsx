import type { ReactNode } from 'react';
import type { InvoiceKind, InvoiceStatus } from '@bos/contracts';
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
  const invoice = { id: ID, kind, status, number, version: 7 };
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
  };
  const html = renderToStaticMarkup(
    <InvoiceActions
      invoice={invoice}
      gates={invoiceGates(invoice, permissionChecker(['finance']), true)}
      reloadHref={`/invoices/${ID}`}
    />,
  );

  it('shows Issue off, with the reason under it and as its tooltip, and no issue form', () => {
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Issue debit note<\/button>/);
    const described = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(described).toBeDefined();
    expect(html).toMatch(
      new RegExp(`id="${described ?? 'missing'}"[^>]*>You created this note, so someone else`),
    );
    expect(html).toContain(
      `title="You created this note, so someone else with issue access must issue it."`,
    );
    expect(html).not.toContain('name="idempotencyKey"');
  });
});
