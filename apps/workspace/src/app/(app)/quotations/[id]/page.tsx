import type { QuotationDetail, QuotationVersionDto } from '@bos/contracts';
import type { CustomerDateFormat, NumberSystems } from '@bos/locale';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { stageLabel } from '@/components/p2/crm/stages';
import { getOpportunity, listPaymentTerms } from '@/components/p2/quote-builder/api';
import { getEvidence, getQuotation } from '@/components/p2/quotations/api';
import { AcceptancePanel } from '@/components/p2/quotations/acceptance-panel';
import { QuotationContents } from '@/components/p2/quotations/contents';
import styles from '@/components/p2/quotations/detail.module.css';
import { addContactAction } from '@/components/p2/customers/actions';
import { DetailActions, hasDetailActions } from '@/components/p2/quotations/detail-actions';
import { opportunityBlockers } from '@/components/p2/quotations/opportunity-gate';
import { pdfLinkFor } from '@/components/p2/quotations/document-link';
import { PdfFailed } from '@/components/p2/quotations/pdf-failed';
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
import { getDateFormat, getNumberSystems } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';
import { getPermissionCheck } from '@/lib/live-permissions';

export const metadata: Metadata = { title: 'Quotation · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The customer PDF of one version: a viewer button, or words. Nothing here requests the document:
 * the route behind the link issues a single-use signed link on every call, so the page only renders
 * a button that fetches the preview when it is opened, and a plain Download anchor (never
 * `next/link`, which would prefetch it). The words go through `PreparingRefresh`, which re-renders
 * the page while a file is on its way and does nothing for words that will not change. It is a
 * client module, so the server cannot ask it `shouldAutoRefresh`: it asks itself. A render the API
 * gave up on reads "could not be prepared", with Retry for a viewer who may send (round 4, R4c2).
 * Download stays in the app: a refusal is a toast, not an error page in the tab.
 */
function Pdf({
  quotation,
  version,
  retry,
}: {
  quotation: QuotationDetail['quotation'];
  version: QuotationVersionDto;
  /** Offer Retry on a failed render: only to a viewer who may send, as the retry route requires `quotation.send`. */
  retry: boolean;
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
      downloadInApp
      pollWhilePreparing
      retryUrl={retry ? `${pdf.href}/retry` : undefined}
      context={`of revision ${version.revisionNo}`}
    />
  ) : pdf.kind === 'failed' ? (
    <span className={styles.pdfWords}>
      <PdfFailed retryHref={retry ? pdf.retryHref : undefined} />
    </span>
  ) : (
    <span className={styles.pdfWords}>
      <PreparingRefresh text={pdf.text} quotationId={quotation.id} versionId={version.id} />
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
  mayRetryPdf: boolean,
  dateFormat?: CustomerDateFormat,
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
      validUntil: when(v.validUntil, 'date', dateFormat),
      note: v.revisionReason,
      pdf: <Pdf quotation={quotation} version={v} retry={mayRetryPdf} />,
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

  // Stage 1: display settings, the viewer's grants (`/v1/me`) and the quotation do not depend on each
  // other, so they start together. Stage 2 below needs the quotation's ids.
  // Unit cost, cost total and margin (D29) arrive only when the viewer's live grants include
  // `quotation.cost.read`: the API leaves them out otherwise, and the components show what is present.
  const [numberSystems, dateFormat, allowed, loaded] = await Promise.all([
    getNumberSystems(),
    getDateFormat(),
    getPermissionCheck(session),
    getQuotation(session, id).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    ),
  ]);
  let detail: QuotationDetail;
  if (loaded.ok) {
    detail = loaded.value;
  } else {
    const f = failureOf(loaded.error);
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
  const accepted = current?.status === 'accepted' ? current : null;

  // The revision on screen: the one `?rev=` names, else the current one. Actions and the client
  // decision always act on the current revision.
  const { rev } = (await searchParams) ?? {};
  const view = requestedRevision(versions, rev) ?? current;
  const earlier = view !== null && view.id !== quotation.currentVersionId;
  const contact =
    view?.contactId != null ? contacts.find((c) => c.id === view.contactId) : undefined;
  // The version carries only the payment term's id. A failed lookup drops the name, not the page.
  const paymentTermId = view?.paymentTermId ?? null;
  // Stage 2: everything that needs the quotation's ids, started together.
  const [orders, evidence, opportunity, paymentTermsName] = await Promise.all([
    accepted && allowed('sales_order.read')
      ? listSalesOrders(session, { quotationVersionId: accepted.id }).catch(() => [])
      : [],
    accepted ? getEvidence(session, quotation.id, accepted.id) : null,
    // The deal's number and stage come from the opportunity itself; a denied or failed read leaves the link out, since it would open a 404.
    Promise.resolve()
      .then(() => getOpportunity(session, quotation.opportunityId))
      .catch(() => null),
    paymentTermId === null
      ? undefined
      : Promise.resolve()
          .then(() => listPaymentTerms(session))
          .then((terms) => terms.find((t) => t.id === paymentTermId)?.label)
          .catch(() => undefined),
  ]);
  const order = orders.find((item) => item.status !== 'cancelled');
  const mayRetryPdf = allowed('quotation.send');
  const maySend = detail.capabilities.canSend ?? allowed('quotation.send');
  const mayRecordOutcome =
    detail.capabilities.canRecordOutcome ?? allowed('quotation.record_acceptance');

  // Send and Accepted are hidden while the opportunity's stage would make the API refuse them; the
  // reason is said here once, to whoever would otherwise have had the button.
  const blockers = current === null ? null : opportunityBlockers(opportunity, current.id);
  const heldBack =
    current === null || blockers === null
      ? null
      : (current.status === 'approved' || current.status === 'expired') &&
          blockers.send !== null &&
          maySend
        ? blockers.send
        : current.status === 'sent' && blockers.accept !== null && mayRecordOutcome
          ? blockers.accept
          : null;

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
            value: (
              <time dateTime={view.validUntil}>{when(view.validUntil, 'date', dateFormat)}</time>
            ),
          },
          {
            key: 'issued',
            label: 'Issued',
            value: (
              <time dateTime={view.issueDate}>{when(view.issueDate, 'date', dateFormat)}</time>
            ),
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
            value: <Pdf quotation={quotation} version={view} retry={mayRetryPdf} />,
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
          current &&
          hasDetailActions({
            status: current.status,
            capabilities: detail.capabilities,
            includeOutcome: true,
            maySend,
            mayRecordOutcome,
            opportunity,
            versionId: current.id,
          }) ? (
            <DetailActions
              quotationId={quotation.id}
              number={quotation.number}
              current={current}
              contacts={contacts}
              createContact={
                allowed('customer.write')
                  ? { action: addContactAction, customerId: quotation.customerId }
                  : null
              }
              capabilities={detail.capabilities}
              reloadHref={path}
              includeOutcome={true}
              maySend={maySend}
              mayRecordOutcome={mayRecordOutcome}
              opportunity={opportunity}
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

      {heldBack !== null ? (
        <Alert tone="info" role="status">
          {heldBack}
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
              <Panel
                className={styles.detailPanel}
                title={earlier ? `Revision ${view.revisionNo}` : 'Current revision'}
                description={`Last changed ${when(view.updatedAt, 'datetime', dateFormat)}`}
                actions={
                  <VersionDrawer
                    number={quotation.number}
                    rows={revisionRows(detail, path, numberSystems, mayRetryPdf, dateFormat)}
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
                paymentTermsName={paymentTermsName}
                numberSystems={numberSystems}
                dateFormat={dateFormat}
              />
            </>
          ) : versions.length > 0 ? (
            <Panel
              className={styles.detailPanel}
              title="Revisions"
              actions={
                <VersionDrawer
                  number={quotation.number}
                  rows={revisionRows(detail, path, numberSystems, mayRetryPdf, dateFormat)}
                />
              }
            >
              <p className={styles.note}>Open the list to see every revision.</p>
            </Panel>
          ) : null}
        </div>

        <div className={`${styles.stack} ${styles.historyStack}`}>
          {current?.status === 'accepted' ? (
            <AcceptancePanel
              quotationId={quotation.id}
              number={quotation.number}
              version={current}
              evidence={evidence}
              confirmedByName={people.get(evidence?.confirmation?.confirmedBy ?? '') ?? undefined}
              order={order}
              mayReadOrders={allowed('sales_order.read')}
              reloadHref={path}
              dateFormat={dateFormat}
            />
          ) : null}

          <StatusHistory
            history={detail.statusHistory}
            versions={versions}
            people={people}
            dateFormat={dateFormat}
          />

          <Panel title="Linked records" className={styles.detailPanel}>
            <ul className={styles.records}>
              <li>
                <Icon name="building" size={18} />
                <Link href={`/customers/${encodeURIComponent(quotation.customerId)}`}>
                  {customerName}
                </Link>
              </li>
              {detail.lead != null ? (
                <li>
                  <Icon name="target" size={18} />
                  <Link href={`/leads/${encodeURIComponent(detail.lead.id)}`}>
                    {detail.lead.name}
                  </Link>
                </li>
              ) : null}
              {opportunity !== null ? (
                <li>
                  <Icon name="briefcase" size={18} />
                  <Link href={`/opportunities/${encodeURIComponent(quotation.opportunityId)}`}>
                    {opportunity.number}
                  </Link>
                  <span className={styles.recordNote}>
                    {stageLabel('opportunity', opportunity.stage)}
                  </span>
                </li>
              ) : null}
            </ul>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
