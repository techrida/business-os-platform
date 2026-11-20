import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { permissionChecker } from '@/components/p2/customers/permissions';

import { invoiceGates } from '../../_lib/gates';
import { invoiceDetail } from '../../_lib/test-fixtures';

import { InvoiceNoteActions } from './note-actions';

const clients = vi.hoisted(() => ({
  CreditNoteDialog: vi.fn((_props: Record<string, unknown>) => null),
  DebitNoteDialog: vi.fn((_props: Record<string, unknown>) => null),
}));
vi.mock('./note-dialogs', () => ({
  ...clients,
  // Next permits rendering a client component, but invoking a function exported
  // by that module on the server throws. Ordinary static-render tests miss it.
  creditSource: () => {
    throw new Error('Cannot call a client helper from a server component');
  },
}));

it('passes plain credit-line data across the server/client boundary without calling a client helper', () => {
  const detail = invoiceDetail();
  renderToStaticMarkup(
    <InvoiceNoteActions
      invoice={detail.invoice}
      lines={detail.lines}
      taxCodes={[]}
      gates={invoiceGates(
        { kind: 'tax_invoice', status: 'issued' },
        permissionChecker(['finance']),
      )}
    />,
  );
  expect(clients.CreditNoteDialog.mock.calls[0]?.[0].lines).toEqual(
    detail.lines.map(({ lineNo, description, uom, quantity }) => ({
      lineNo,
      description,
      uom,
      quantity,
    })),
  );
});
