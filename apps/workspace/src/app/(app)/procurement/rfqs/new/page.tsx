import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystem } from '@bos/locale';

import { isGuid } from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { listPurchaseRequests, type PurchaseRequestListItem } from '@/lib/api-procurement';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystem } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';

import layout from '../../procurement.module.css';
import { createRfqAction } from '../actions';
import { RfqForm } from '../_components/rfq-form';
import { rfqFailure } from '../_lib/failure';
import { rfqGrants } from '../_lib/model';
import { loadVendors, vendorName } from '../_lib/vendors';

export const metadata: Metadata = { title: 'New RFQ · Business OS' };
export const dynamic = 'force-dynamic';

const here = '/procurement/rfqs/new';

function label(pr: PurchaseRequestListItem, numberSystem: NumberSystem): string {
  const text =
    pr.justification.length > 60 ? `${pr.justification.slice(0, 60)}…` : pr.justification;
  return `${pr.number ?? 'Not numbered'} · ${money(pr.estimatedTotal, pr.currency, numberSystem)} · needed ${when(pr.requiredBy, 'date')} · ${text}`;
}

export default async function NewRfqPage({
  searchParams,
}: {
  searchParams: Promise<{ pr?: string | string[] }>;
}) {
  const session = await requireStaffSession(here);
  const numberSystem = await getNumberSystem();
  const sp = await searchParams;
  const allowed = rfqGrants(session.roles).sourcing;
  const wanted = typeof sp.pr === 'string' && isGuid(sp.pr) ? sp.pr : '';

  const crumbs = (
    <Breadcrumb
      items={[{ label: 'Requests for quotation', href: '/procurement/rfqs' }, { label: 'New RFQ' }]}
    />
  );
  const header = (
    <>
      {crumbs}
      <PageHeader
        title="New RFQ"
        description="Ask approved vendors to quote on a department-approved purchase request."
      />
    </>
  );

  if (!allowed) {
    return (
      <Page width="narrow">
        {header}
        <Alert
          tone="info"
          role="status"
          title="Your roles do not include sourcing"
          actions={
            <LinkButton href="/procurement/rfqs" variant="secondary">
              Back to RFQs
            </LinkButton>
          }
        >
          Ask an administrator if you need to open RFQs.
        </Alert>
      </Page>
    );
  }

  const [requestsResult, vendorLookup] = await Promise.all([
    listPurchaseRequests(session, { status: 'dept_approved', limit: 100 }).then(
      (rows) => ({ rows }),
      (err: unknown) => ({ problem: rfqFailure(err, 'load').message }),
    ),
    loadVendors(session, 'approved'),
  ]);

  const problem =
    'problem' in requestsResult
      ? { title: 'Purchase requests did not load', message: requestsResult.problem }
      : vendorLookup.problem !== undefined
        ? { title: 'Vendors did not load', message: vendorLookup.problem }
        : null;

  if (problem !== null) {
    return (
      <Page width="narrow">
        {header}
        <Alert
          tone="error"
          role="alert"
          title={problem.title}
          actions={<Link href={wanted ? `${here}?pr=${wanted}` : here}>Try again</Link>}
        >
          {problem.message}
        </Alert>
      </Page>
    );
  }

  const rows = 'rows' in requestsResult ? requestsResult.rows : [];
  const vendors = vendorLookup.vendors ?? [];
  if (rows.length === 0 || vendors.length === 0) {
    return (
      <Page width="narrow">
        {header}
        <Alert
          tone="info"
          role="status"
          title={
            rows.length === 0
              ? 'No purchase request is ready for an RFQ'
              : 'No approved vendors to invite'
          }
          actions={
            <LinkButton
              href={rows.length === 0 ? '/procurement/requests' : '/vendors'}
              variant="secondary"
            >
              {rows.length === 0 ? 'Open purchase requests' : 'Open vendors'}
            </LinkButton>
          }
        >
          {rows.length === 0
            ? 'An RFQ starts from a purchase request the department head has approved. Approved requests without an RFQ show here.'
            : 'Only approved vendors can be invited. Approve a vendor first, then come back.'}
        </Alert>
      </Page>
    );
  }

  return (
    <Page className={layout.formPage}>
      {crumbs}
      <RfqForm
        action={createRfqAction}
        idempotencyKey={randomUUID()}
        requests={rows.map((pr) => ({ id: pr.id, label: label(pr, numberSystem) }))}
        vendors={vendors.map((v) => ({ id: v.id, name: vendorName(v) }))}
        initialRequestId={rows.some((r) => r.id === wanted) ? wanted : ''}
        cancelHref="/procurement/rfqs"
        reloadHref={wanted ? `${here}?pr=${wanted}` : here}
      />
    </Page>
  );
}
