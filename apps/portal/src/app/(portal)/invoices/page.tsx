import { redirect } from 'next/navigation';

import { FilteredEmpty } from '@/components/portal/filtered-empty';
import { ListFilters } from '@/components/portal/list-filters';
import styles from '@/components/portal/page.module.css';
import { EmptyState } from '@/components/ui/empty-state';
import { ApiError } from '@/lib/api';
import { listPortalInvoices } from '@/lib/api.billing';
import { matchesSelection, matchesText } from '@/lib/list-filter';
import { activeFilterLabels, clearFiltersHref, readList, type RawParams } from '@/lib/list-params';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import { InvoiceList } from './_components/invoice-list';
import {
  INVOICE_FILTER_LABELS,
  INVOICE_FILTER_SPEC,
  KIND_OPTIONS,
} from './_components/invoice-filters';

export const dynamic = 'force-dynamic';

const LOGIN = '/auth/login?returnTo=%2Finvoices';
const HERE = '/invoices';

/**
 * The customer's own issued invoices and notes, as the API returns them. The API lists issued
 * documents of the session's party only, and the strict list schema refuses anything else (a 502,
 * shown by the error page), so a draft can never be listed here.
 */
export default async function InvoicesPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const session = await getSession();
  if (!session) redirect(LOGIN);

  const display = getPortalDisplay(session);
  let items;
  try {
    items = await listPortalInvoices(session);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect(LOGIN);
    if (err instanceof ApiError && err.status === 403) redirect('/no-access');
    throw err;
  }

  // The API has no query parameters and returns this customer's whole list, so filter it here.
  const raw = await searchParams;
  const list = readList(raw, INVOICE_FILTER_SPEC);
  const shown = items.filter(
    (inv) => matchesSelection(list.multi.kind, inv.kind) && matchesText(list.q, [inv.number]),
  );

  return (
    <main className={styles.main}>
      <div className={styles.head}>
        <h1 className={styles.title}>Your invoices</h1>
        <p className={styles.lede}>Invoices and notes we have issued to you appear here.</p>
      </div>
      {items.length === 0 ? (
        <EmptyState title="No invoices yet" icon="receipt">
          When we issue you an invoice, it will be listed here with its payment status.
        </EmptyState>
      ) : (
        <>
          <ListFilters
            searchLabel="Search invoices"
            placeholder="Search by invoice number"
            filters={[
              {
                name: 'kind',
                label: 'Type',
                options: KIND_OPTIONS,
                value: list.multi.kind,
                allLabel: 'All types',
                pluralLabel: 'types',
              },
            ]}
            shown={shown.length}
            total={shown.length}
            noun="invoice"
          />
          {shown.length === 0 ? (
            <FilteredEmpty
              noun="invoices"
              labels={activeFilterLabels(list, INVOICE_FILTER_LABELS, 'Search')}
              clearHref={clearFiltersHref(HERE, raw, INVOICE_FILTER_SPEC)}
            />
          ) : (
            <InvoiceList items={shown} display={await display} />
          )}
        </>
      )}
    </main>
  );
}
