import { notFound, redirect } from 'next/navigation';

import { FilteredEmpty } from '@/components/portal/filtered-empty';
import { ListFilters } from '@/components/portal/list-filters';
import pageStyles from '@/components/portal/page.module.css';
import { PurchaseOrderList } from '@/components/vendor/po-list';
import {
  PO_FILTER_LABELS,
  PO_FILTER_SPEC,
  PO_STATUS_OPTIONS,
} from '@/components/vendor/vendor-filters';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { listVendorPurchaseOrders } from '@/lib/api.vendor';
import { matchesSelection, matchesText } from '@/lib/list-filter';
import { activeFilterLabels, clearFiltersHref, readList, type RawParams } from '@/lib/list-params';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import { loadVendor } from '../load';

export const dynamic = 'force-dynamic';

const HERE = '/vendor/purchase-orders';

/**
 * The vendor's purchase orders, issued versions only. A vendor who may only onboard gets a 403
 * from the API, shown as the in-place no-access notice (the top bar already hides this link).
 */
export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(HERE)}`);

  const display = getPortalDisplay(session);
  const result = await loadVendor(() => listVendorPurchaseOrders(session), HERE);
  if (result.kind === 'forbidden') return <VendorNoAccess />;
  if (result.kind === 'missing') notFound();

  // The API has no query parameters and returns this vendor's whole list, so filter it here.
  const raw = await searchParams;
  const list = readList(raw, PO_FILTER_SPEC);
  const shown = result.data.filter(
    (po) => matchesSelection(list.multi.status, po.status) && matchesText(list.q, [po.number]),
  );

  return (
    <main className={pageStyles.main}>
      <div className={pageStyles.head}>
        <h1 className={pageStyles.title}>Your purchase orders</h1>
        <p className={pageStyles.lede}>Orders we have issued to you, at their latest version.</p>
      </div>
      {result.data.length === 0 ? (
        <PurchaseOrderList items={result.data} display={await display} />
      ) : (
        <>
          <ListFilters
            searchLabel="Search purchase orders"
            placeholder="Search by order number"
            filters={[
              {
                name: 'status',
                label: 'Status',
                options: PO_STATUS_OPTIONS,
                value: list.multi.status,
                allLabel: 'All statuses',
                pluralLabel: 'statuses',
              },
            ]}
            shown={shown.length}
            total={shown.length}
            noun="purchase order"
          />
          {shown.length === 0 ? (
            <FilteredEmpty
              noun="purchase orders"
              labels={activeFilterLabels(list, PO_FILTER_LABELS)}
              clearHref={clearFiltersHref(HERE, raw, PO_FILTER_SPEC)}
            />
          ) : (
            <PurchaseOrderList items={shown} display={await display} />
          )}
        </>
      )}
    </main>
  );
}
