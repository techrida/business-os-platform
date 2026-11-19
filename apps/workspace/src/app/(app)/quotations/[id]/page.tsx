import type { QuotationDetail, QuotationVersionDto } from '@bos/contracts';
import type { NumberSystems } from '@bos/locale';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { hasPermission } from '@/components/p2/customers/permissions';
import { listPaymentTerms } from '@/components/p2/quote-builder/api';
import { getQuotation } from '@/components/p2/quotations/api';
import { QuotationContents } from '@/components/p2/quotations/contents';
import styles from '@/components/p2/quotations/detail.module.css';
import { ClientDecision, DetailActions } from '@/components/p2/quotations/detail-actions';
import { pdfLinkFor } from '@/components/p2/quotations/document-link';
import {
  canSeeInternalFigures,
  withoutInternalFigures,
} from '@/components/p2/quotations/internal-data';
import { PreparingRefresh } from '@/components/p2/quotations/preparing-refresh';
import { QuotationStatusBadge } from '@/components/p2/quotations/status-badge';
import { StatusHistory } from '@/components/p2/quotations/status-history';
import { VersionDrawer, type RevisionRow } from '@/components/p2/quotations/version-drawer';
import { Alert } from '@/components/ui/alert';
import { Icon } from '@/components/ui/icon';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { ViewDocument } from '@/components/ui/view-document';
import { listSalesOrders } from '@/lib/api-billing';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';

export const metadata: Metadata = { title: 'Quotation · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The customer PDF of one version: a viewer button, or words. Nothing here requests the document:
 * the route behind the link issues a single-use signed link on every call, so the page only renders
 * a button that fetches the preview when it is opened, and a plain Download anchor (never
 * `next/link`, which would prefetch it). The words go through `PreparingRefresh`, which re-renders
 * the page while a file is on its way and does nothing for words that will not change. It is a
 * client module, so the server cannot ask it `shouldAutoRefresh`: it asks itself.
 */
function Pdf({
  quotation,
  version,
}: {
  quotation: QuotationDetail['quotation'];
  version: QuotationVersionDto;
}) {
  const pdf = pdfLinkFor(quotation.id, version);
  return pdf.kind === 'link' ? (
    <ViewDocument
      name={`${quotation.number}-rev${version.revisionNo}.pdf`}
      previewUrl={`${pdf.href}/preview`}
      downloadUrl={pdf.href}
      label="View PDF"
      variant="link"
      withDownload
      context={`of revision ${version.revisionNo}`}
    />
  ) : (
    <span className={styles.pdfWords}>
      <PreparingRefresh text={pdf.text} />
    </span>
  );
}

/**
 * The revision the `?rev=` query names: a version id or a revision number. Anything else (absent,
 * repeated, malformed, unknown) names nothing, and the page shows the current revision.
 */
function requestedRevision(
  versions: readonly QuotationVersionDto[],
  rev: string | string[] | undefined,
): QuotationVersionDto | null {
  if (typeof rev !== 'string') return null;
  if (UUID.test(rev)) return versions.find((v) => v.id.toLowerCase() === rev.toLowerCase()) ?? null;
  if (/^[1-9][0-9]{0,5}$/.test(rev))
    return versions.find((v) => v.revisionNo === Number(rev)) ?? null;
  return null;
}

function Totals({
  version,
  numberSystems,
}: {
  version: QuotationVersionDto;
  numberSystems: NumberSystems;
}) {
  const { totals, currency } = version;
  const rows: { key: string; label: string; value: string; grand?: boolean }[] = [
    { key: 'subtotal', label: 'Subtotal', value: totals.subtotal },
    {
      key: 'discount',
      label:
        Number(totals.effectiveDiscountPct) > 0
          ? `Discount (${totals.effectiveDiscountPct}%)`
          : 'Discount',
      value: totals.discountAmount,
    },
    { key: 'taxable', label: 'Taxable amount', value: totals.taxableAmount },
    { key: 'tax', label: 'Tax', value: totals.taxAmount },
    { key: 'total', label: 'Total', value: totals.total, grand: true },
  ];
  return (
    <Panel as="aside" title="Totals" className={styles.detailPanel}>
      <dl className={styles.totals}>
        {rows.map((row) => (
          <div
            key={row.key}
            className={row.grand ? `${styles.totalRow} ${styles.grandTotal}` : styles.totalRow}
          >
            <dt className={styles.totalTerm}>{row.label}</dt>
            <dd className={styles.totalValue}>{money(row.value, currency, numberSystems)}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function revisionRows(
  detail: QuotationDetail,
  path: string,
  numberSystems: NumberSystems,
): RevisionRow[] {
  const { quotation, versions } = detail;
  return [...versions]
    .sort((a, b) => b.revisionNo - a.revisionNo)
    .map((v) => ({
      id: v.id,
      label: `Rev ${v.revisionNo}`,
      href: v.id === quotation.currentVersionId ? path : `${path}?rev=${encodeURIComponent(v.id)}`,
      current: v.id === quotation.currentVersionId,
      status: <QuotationStatusBadge status={v.status} rejectionSource={v.rejectionSource} />,
      total: money(v.totals.total, v.currency, numberSystems),
      validUntil: when(v.validUntil, 'date'),
      note: v.revisionReason,
      pdf: <Pdf quotation={quotation} version={v} />,
    }));
}

export default async function QuotationDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ rev?: string | string[] }>;
}) {
  const { id } = await params;
  // Not a UUID: no quotation can have this id, so there is nothing to ask the API.
  if (!UUID.test(id)) notFound();
  const path = `/quotations/${encodeURIComponent(id)}`;
  const session = await requireStaffSession(path);

  const numberSystems = await getNumberSystems();
  // Internal figures (unit cost, cost total, margin) are removed here, before the data reaches any
  // component: the rest of this function only ever sees `detail`, so they cannot leak into a client prop.
  const internalVisible = canSeeInternalFigures(session.roles);
  let detail: QuotationDetail;
  try {
    const loaded = await getQuotation(session, id);
    detail = internalVisible ? loaded : withoutInternalFigures(loaded);
  } catch (err) {
    const f = failureOf(err);
    if (f.status === 404) notFound();
    return (
      <Page width="narrow">
        <Breadcrumb
          items={[{ label: 'Quotations', href: '/quotations' }, { label: 'Quotation' }]}
        />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            f.status === 403
              ? 'Your roles do not include quotations'
              : 'This quotation did not load'
          }
          actions={f.status !== 403 ? <Link href={path}>Try again</Link> : null}
        >
          {f.status === 403
            ? 'Quotations are for the sales team and the people who approve them. Ask an administrator if you need access.'
            : f.message}
        </Alert>
      </Page>
    );
  }

  const { quotation, versions, customerName, contacts } = detail;
  const current = versions.find((v) => v.id === quotation.currentVersionId) ?? null;
  const orders =
    current?.status === 'accepted' && hasPermission(session.roles, 'sales_order.read')
      ? await listSalesOrders(session, { quotationVersionId: current.id }).catch(() => [])
      : [];
  const order = orders.find((item) => item.status !== 'cancelled');

  // The revision on screen: the one `?rev=` names, else the current one. Actions and the client
  // decision always act on the current revision.
  const { rev } = (await searchParams) ?? {};
  const view = requestedRevision(versions, rev) ?? current;
  const earlier = view !== null && view.id !== quotation.currentVersionId;
  const contact =
    view?.contactId != null ? contacts.find((c) => c.id === view.contactId) : undefined;
  // The version carries only the payment term's id. A failed lookup drops the name, not the page.
  const paymentTermId = view?.paymentTermId ?? null;
  const paymentTermsName =
    paymentTermId === null
      ? undefined
      : await Promise.resolve()
          .then(() => listPaymentTerms(session))
          .then((terms) => terms.find((t) => t.id === paymentTermId)?.label)
          .catch(() => undefined);

  // The quotation returns the names of the people it names (owner, history actors): no admin directory.
  const people = new Map((detail.people ?? []).map((p) => [p.userId, p.name]));
  const facts: Fact[] =
    view === null
      ? []
      : [
          {
            key: 'revision',
            label: 'Revision',
            value: `Rev ${view.revisionNo} of ${versions.length}`,
          },
          {
            key: 'valid',
            label: 'Valid until',
            value: <time dateTime={view.validUntil}>{when(view.validUntil, 'date')}</time>,
          },
          {
            key: 'issued',
            label: 'Issued',
            value: <time dateTime={view.issueDate}>{when(view.issueDate, 'date')}</time>,
          },
          {
            key: 'owner',
            label: 'Owner',
            value:
              quotation.ownerUserId !== null ? (
                <span>{people.get(quotation.ownerUserId) ?? 'Owner name unavailable'}</span>
              ) : (
                <span className={styles.quiet}>Unassigned</span>
              ),
          },
          ...(contact !== undefined
            ? [
                {
                  key: 'contact',
                  label: 'Customer contact',
                  value: <span className={styles.wrap}>{contact.name}</span>,
                },
              ]
            : []),
          {
            key: 'pdf',
            label: 'Customer PDF',
            value: <Pdf quotation={quotation} version={view} />,
          },
          ...(view.revisionReason !== null
            ? [
                {
                  key: 'reason',
                  label: 'Why this revision',
                  value: <span className={styles.wrap}>{view.revisionReason}</span>,
                  wide: true,
                },
              ]
            : []),
        ];

  return (
    <Page>
      <Breadcrumb
        items={[{ label: 'Quotations', href: '/quotations' }, { label: quotation.number }]}
      />
      <PageHeader
        title={<span className={styles.wrap}>{quotation.number}</span>}
        description={
          <span className={styles.headerMeta}>
            <span>{customerName}</span>
            {current ? (
              <>
                <span className={styles.headerFact}>Revision {current.revisionNo}</span>
                <span className={styles.headerFact}>
                  {money(current.totals.total, current.currency, numberSystems)}
                </span>
              </>
            ) : null}
            <QuotationStatusBadge
              status={quotation.status}
              rejectionSource={current?.rejectionSource ?? null}
            />
          </span>
        }
        actions={
          current ? (
            <DetailActions
              quotationId={quotation.id}
              number={quotation.number}
              current={current}
              contacts={contacts}
              capabilities={detail.capabilities}
              reloadHref={path}
              includeOutcome={false}
            />
          ) : null
        }
      />

      {current === null ? (
        <Alert
          tone="warning"
          role="alert"
          title="The current revision is missing from this answer."
        >
          The current revision could not be loaded. Reload to try again. Earlier revisions remain
          available below.
        </Alert>
      ) : null}

      {current?.cancelReason != null ? (
        <Alert tone="info" title="This revision was cancelled.">
          <span className={styles.wrap}>{current.cancelReason}</span>
        </Alert>
      ) : null}

      <div className={styles.columns}>
        <div className={`${styles.stack} ${styles.revisionStack}`}>
          {view !== null ? (
            <>
              {current !== null && !earlier ? (
                <ClientDecision
                  quotationId={quotation.id}
                  number={quotation.number}
                  current={current}
                  reloadHref={path}
                />
              ) : null}
              <Panel
                className={styles.detailPanel}
                title={earlier ? `Revision ${view.revisionNo}` : 'Current revision'}
                description={`Last changed ${when(view.updatedAt)}`}
                actions={
                  <VersionDrawer
                    number={quotation.number}
                    rows={revisionRows(detail, path, numberSystems)}
                  />
                }
              >
                <FactList facts={facts} className={styles.facts ?? ''} />
              </Panel>
              <Totals version={view} numberSystems={numberSystems} />
              {earlier ? (
                <div className={styles.revisionBar}>
                  <span>Revision {view.revisionNo} contents</span>
                  {current !== null ? (
                    <Link href={path} prefetch={false}>
                      Back to current revision
                    </Link>
                  ) : null}
                </div>
              ) : null}
              <QuotationContents
                version={view}
                internalVisible={internalVisible}
                paymentTermsName={paymentTermsName}
                numberSystems={numberSystems}
              />
            </>
          ) : versions.length > 0 ? (
            <Panel
              className={styles.detailPanel}
              title="Revisions"
              actions={
                <VersionDrawer
                  number={quotation.number}
                  rows={revisionRows(detail, path, numberSystems)}
                />
              }
            >
              <p className={styles.note}>Open the list to see every revision.</p>
            </Panel>
          ) : null}
        </div>

        <div className={`${styles.stack} ${styles.historyStack}`}>
          <StatusHistory history={detail.statusHistory} versions={versions} people={people} />

          <Panel title="Linked records" className={styles.detailPanel}>
            <ul className={styles.records}>
              <li>
                <Icon name="building" size={18} />
                <Link href={`/customers/${encodeURIComponent(quotation.customerId)}`}>
                  {customerName}
                </Link>
              </li>
              <li>
                <Icon name="briefcase" size={18} />
                <Link href={`/opportunities/${encodeURIComponent(quotation.opportunityId)}`}>
                  View opportunity
                </Link>
              </li>
              {order ? (
                <li>
                  <Icon name="briefcase" size={18} />
                  <Link href={`/sales-orders/${encodeURIComponent(order.id)}`}>
                    {order.number === null ? 'Sales order' : `Sales order ${order.number}`}
                  </Link>
                </li>
              ) : null}
            </ul>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
