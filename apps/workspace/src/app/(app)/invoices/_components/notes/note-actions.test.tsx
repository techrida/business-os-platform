import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { invoiceGates } from '../../_lib/gates';
import { ID, TAX, invoiceDetail } from '../../_lib/test-fixtures';

import { InvoiceNoteActions } from './note-actions';

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

const lines = invoiceDetail().lines;
const taxCodes = [{ id: TAX, label: 'VAT 13%' }];

function render(
  roles: string[],
  over: { status?: 'issued' | 'draft'; taxCodes?: typeof taxCodes | null } = {},
) {
  const status = over.status ?? 'issued';
  const invoice = { id: ID, kind: 'tax_invoice' as const, status, number: 'INV-2083/84-00001' };
  return renderToStaticMarkup(
    <InvoiceNoteActions
      invoice={{ ...invoice, currency: 'NPR' }}
      lines={lines}
      taxCodes={over.taxCodes === undefined ? taxCodes : over.taxCodes}
      gates={invoiceGates(invoice, roles)}
    />,
  );
}

const triggers = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*>(Credit note|Debit note)<\/button>/g)].map((m) => m[1] ?? '');

describe('the credit and debit note buttons', () => {
  it('are shown to Finance on an issued tax invoice', () => {
    expect(triggers(render(['finance']))).toEqual(['Credit note', 'Debit note']);
  });

  it('are hidden from the Accountant and from a role that only reads', () => {
    expect(render(['accountant'])).toBe('');
    expect(render(['management'])).toBe('');
  });

  it('are hidden while the invoice is not issued', () => {
    expect(render(['finance'], { status: 'draft' })).toBe('');
  });
});

describe('the dialogs', () => {
  const html = render(['finance']);

  it('send the original invoice and one distinct key per note', () => {
    expect(html.match(/name="originalInvoiceId" value="[^"]+"/g)).toHaveLength(2);
    const keys = [...html.matchAll(/name="idempotencyKey" value="([^"]+)"/g)].map((m) => m[1]);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    for (const k of keys) expect(k).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('ask for a reason in each, and name the invoice', () => {
    expect(html.match(/name="reason"/g)).toHaveLength(2);
    expect(html).toContain('Credit note for INV-2083/84-00001');
    expect(html).toContain('Debit note for INV-2083/84-00001');
  });

  it('list the original lines to credit with what the invoice holds, and take no prices', () => {
    expect(html).toContain('Advance 40% of the website build');
    expect(html).toContain('1.0000 lot');
    expect(html).toContain('name="lines"');
    expect(html).not.toMatch(/name="(number|issueDate|total)"/);
  });

  it('say so when the tax codes did not load, so a debit note cannot be written blind', () => {
    expect(render(['finance'], { taxCodes: null })).toContain('tax codes did not load');
  });
});
