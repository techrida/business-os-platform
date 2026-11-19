import { notFound, redirect } from 'next/navigation';

import { FilteredEmpty } from '@/components/portal/filtered-empty';
import { ListFilters } from '@/components/portal/list-filters';
import pageStyles from '@/components/portal/page.module.css';
import { LinkButton } from '@/components/ui/button';
import { BillList } from '@/components/vendor/bill-list';
import vendorStyles from '@/components/vendor/vendor.module.css';
import {
  BILL_FILTER_LABELS,
  BILL_FILTER_SPEC,
  BILL_STATUS_OPTIONS,
} from '@/components/vendor/vendor-filters';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { getVendorOnboarding, listVendorBills } from '@/lib/api.vendor';
import { matchesSelection, matchesText } from '@/lib/list-filter';
import { activeFilterLabels, clearFiltersHref, readList, type RawParams } from '@/lib/list-params';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import { loadVendor } from '../load';

export const dynamic = 'force-dynamic';

const HERE = '/vendor/bills';

/**
 * The vendor's bills with a coarse status: matching and approval steps stay private. Only a vendor
 * with full access gets the Submit a bill link. That comes from the onboarding read, which is an
 * extra: if it fails for any reason the link is hidden and the list still shows.
 */
export default async function BillsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(HERE)}`);

  const display = getPortalDisplay(session);
  const [result, capability] = await Promise.all([
    loadVendor(() => listVendorBills(session), HERE),
    getVendorOnboarding(session).then(
      (view) => view.capability,
      () => null,
    ),
  ]);
  if (result.kind === 'forbidden') return <VendorNoAccess />;
  if (result.kind === 'missing') notFound();

  // The API has no query parameters and returns this vendor's whole list, so filter it here.
  const raw = await searchParams;
  const list = readList(raw, BILL_FILTER_SPEC);
  const shown = result.data.filter(
    (bill) =>
      matchesSelection(list.multi.status, bill.status) &&
      matchesText(list.q, [bill.number, bill.vendorInvoiceNo]),
  );

  return (
    <main className={pageStyles.main}>
      <div className={pageStyles.head}>
        <h1 className={pageStyles.title}>Your bills</h1>
        <p className={pageStyles.lede}>
          Bills we have received from you and where each one stands.
        </p>
      </div>
      <div className={vendorStyles.section}>
        {capability === 'full' ? (
          <div className={vendorStyles.download}>
            <LinkButton href="/vendor/bills/new">Submit a bill</LinkButton>
          </div>
        ) : null}
        {result.data.length === 0 ? (
          <BillList items={result.data} display={await display} />
        ) : (
          <>
            <ListFilters
              searchLabel="Search bills"
              placeholder="Search by bill or invoice number"
              filters={[
                {
                  name: 'status',
                  label: 'Status',
                  options: BILL_STATUS_OPTIONS,
                  value: list.multi.status,
                  allLabel: 'All statuses',
                  pluralLabel: 'statuses',
                },
              ]}
              shown={shown.length}
              total={shown.length}
              noun="bill"
            />
            {shown.length === 0 ? (
              <FilteredEmpty
                noun="bills"
                labels={activeFilterLabels(list, BILL_FILTER_LABELS)}
                clearHref={clearFiltersHref(HERE, raw, BILL_FILTER_SPEC)}
              />
            ) : (
              <BillList items={shown} display={await display} />
            )}
          </>
        )}
      </div>
    </main>
  );
}
