import { notFound, redirect } from 'next/navigation';

import { FilteredEmpty } from '@/components/portal/filtered-empty';
import { ListFilters } from '@/components/portal/list-filters';
import pageStyles from '@/components/portal/page.module.css';
import { isPastDeadline, RfqList } from '@/components/vendor/rfq-list';
import {
  RFQ_FILTER_LABELS,
  RFQ_FILTER_SPEC,
  RFQ_STATUS_OPTIONS,
} from '@/components/vendor/vendor-filters';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { getVendorOnboarding, listVendorRfqs } from '@/lib/api.vendor';
import { matchesSelection, matchesText } from '@/lib/list-filter';
import { activeFilterLabels, clearFiltersHref, readList, type RawParams } from '@/lib/list-params';
import { getSession } from '@/lib/session';

import { loadVendor } from '../load';

export const dynamic = 'force-dynamic';

const HERE = '/vendor/rfqs';

/**
 * The requests for quotation the vendor is invited to. Needs a full vendor account: any other
 * gets the no-access notice before the list is read, and a 403 from the API shows the same notice.
 */
export default async function RfqsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(HERE)}`);

  const onboarding = await loadVendor(() => getVendorOnboarding(session), HERE);
  if (onboarding.kind === 'forbidden') return <VendorNoAccess />;
  if (onboarding.kind === 'missing') notFound();
  if (onboarding.data.capability !== 'full') return <VendorNoAccess />;

  const result = await loadVendor(() => listVendorRfqs(session), HERE);
  if (result.kind === 'forbidden') return <VendorNoAccess />;
  if (result.kind === 'missing') notFound();

  // The API has no query parameters and returns this vendor's whole list, so filter it here.
  const raw = await searchParams;
  const list = readList(raw, RFQ_FILTER_SPEC);
  const now = new Date();
  const shown = result.data.filter(
    (rfq) =>
      matchesSelection(list.multi.status, isPastDeadline(rfq.deadline, now) ? 'closed' : 'open') &&
      matchesText(list.q, [rfq.number]),
  );

  return (
    <main className={pageStyles.main}>
      <div className={pageStyles.head}>
        <h1 className={pageStyles.title}>Requests for quotation</h1>
        <p className={pageStyles.lede}>
          Requests we have invited you to price. Open one to see the items and send your quotation
          before it closes.
        </p>
      </div>
      {result.data.length === 0 ? (
        <RfqList items={result.data} now={now} />
      ) : (
        <>
          <ListFilters
            searchLabel="Search requests"
            placeholder="Search by request number"
            filters={[
              {
                name: 'status',
                label: 'Status',
                options: RFQ_STATUS_OPTIONS,
                value: list.multi.status,
                allLabel: 'All statuses',
                pluralLabel: 'statuses',
              },
            ]}
            shown={shown.length}
            total={shown.length}
            noun="request"
          />
          {shown.length === 0 ? (
            <FilteredEmpty
              noun="requests"
              labels={activeFilterLabels(list, RFQ_FILTER_LABELS)}
              clearHref={clearFiltersHref(HERE, raw, RFQ_FILTER_SPEC)}
            />
          ) : (
            <RfqList items={shown} now={now} />
          )}
        </>
      )}
    </main>
  );
}
