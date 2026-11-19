import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import { SessionUnavailableError } from '@/lib/session-unavailable';

import InvoiceError from './invoices/[id]/error';
import InvoicesError from './invoices/error';
import NewInvoiceError from './invoices/new/error';
import NewPaymentError from './payments/new/error';
import ReceivablesAgingError from './receivables/aging/error';
import CustomerStatementError from './receivables/customers/[id]/error';
import SalesOrderError from './sales-orders/[id]/error';
import SalesOrdersError from './sales-orders/error';

it.each([
  [InvoiceError, 'This invoice did not open'],
  [InvoicesError, 'The invoices did not open'],
  [NewInvoiceError, 'The invoice form did not open'],
  [NewPaymentError, 'The payment form did not open'],
  [ReceivablesAgingError, 'The aging report did not open'],
  [CustomerStatementError, 'The statement did not open'],
  [SalesOrderError, 'This sales order did not open'],
  [SalesOrdersError, 'The sales orders did not open'],
] as const)(
  'preserves the %s fallback and retries a digest-only session outage',
  (Boundary, title) => {
    const callbacks = { retry: vi.fn(), reset: vi.fn() };
    const { digest } = new SessionUnavailableError();
    const outage: ReactElement<{ retry: () => void }> = Boundary({
      error: { digest },
      ...callbacks,
    });
    expect(renderToStaticMarkup(outage)).toContain('Session check temporarily unavailable');
    expect(outage.props.retry).toBe(callbacks.retry);
    const generic = renderToStaticMarkup(<Boundary error={new Error('private')} {...callbacks} />);
    expect(generic).toContain(title);
    expect(generic).not.toContain('private');
  },
);
