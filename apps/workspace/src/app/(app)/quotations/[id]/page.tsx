import type { QuotationDetail, QuotationVersionDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getQuotation } from '@/components/p2/quotations/api';
import styles from '@/components/p2/quotations/detail.module.css';
import { ClientDecision, DetailActions } from '@/components/p2/quotations/detail-actions';
import { pdfLinkFor } from '@/components/p2/quotations/document-link';
import { QuotationStatusBadge } from '@/components/p2/quotations/status-badge';
import { StatusHistory } from '@/components/p2/quotations/status-history';
import { VersionDrawer, type RevisionRow } from '@/components/p2/quotations/version-drawer';
import { Alert } from '@/components/ui/alert';
import { Icon } from '@/components/ui/icon';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel, type Fact } from '@/components/ui/panel';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { money, when } from '@/lib/kernel-format';

export const metadata: Metadata = { title: 'Quotation · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The customer PDF of one version: a link, or words. The link is a plain anchor and never
 * `next/link`: the route behind it issues a single-use signed link on every call, and a prefetch
 * would spend it before the person clicks.
 */
function Pdf({ quotationId, version }: { quotationId: string; version: QuotationVersionDto }) {
  const pdf = pdfLinkFor(quotationId, version);
  return pdf.kind === 'link' ? (
    <a href={pdf.href}>Download PDF</a>
  ) : (
    <span className={styles.pdfWords}>{pdf.text}</span>
  );
}

function Totals({ version }: { version: QuotationVersionDto }) {
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
            <dd className={styles.totalValue}>{money(row.value, currency)}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}

function revisionRows(detail: QuotationDetail): RevisionRow[] {
  const { quotation, versions } = detail;
  return [...versions]
    .sort((a, b) => b.revisionNo - a.revisionNo)
    .map((v) => ({
      id: v.id,
      label: `Rev ${v.revisionNo}`,
      current: v.id === quotation.currentVersionId,
      status: <QuotationStatusBadge status={v.status} rejectionSource={v.rejectionSource} />,
      total: money(v.totals.total, v.currency),
      validUntil: when(v.validUntil, 'date'),
      note: v.revisionReason,
      pdf: <Pdf quotationId={quotation.id} version={v} />,
    }));
}

export default async function QuotationDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // Not a UUID: no quotation can have this id, so there is nothing to ask the API.
  if (!UUID.test(id)) notFound();
  const path = `/quotations/${encodeURIComponent(id)}`;
  const session = await requireStaffSession(path);

  let detail: QuotationDetail;
  try {
    detail = await getQuotation(session, id);
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
  const contact =
    current?.contactId != null ? contacts.find((c) => c.id === current.contactId) : undefined;

  const facts: Fact[] =
    current === null
      ? []
      : [
          {
            key: 'revision',
            label: 'Revision',
            value: `Rev ${current.revisionNo} of ${versions.length}`,
          },
          {
            key: 'valid',
            label: 'Valid until',
            value: <time dateTime={current.validUntil}>{when(current.validUntil, 'date')}</time>,
          },
          {
            key: 'issued',
            label: 'Issued',
            value: <time dateTime={current.issueDate}>{when(current.issueDate, 'date')}</time>,
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
            value: <Pdf quotationId={quotation.id} version={current} />,
          },
          ...(current.revisionReason !== null
            ? [
                {
                  key: 'reason',
                  label: 'Why this revision',
                  value: <span className={styles.wrap}>{current.revisionReason}</span>,
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
                  {money(current.totals.total, current.currency)}
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
          The current revision could not be loaded. The history below is still correct. Reload to
          try again.
        </Alert>
      ) : null}

      {current?.cancelReason != null ? (
        <Alert tone="info" title="This revision was cancelled.">
          <span className={styles.wrap}>{current.cancelReason}</span>
        </Alert>
      ) : null}

      <div className={styles.columns}>
        <div className={`${styles.stack} ${styles.revisionStack}`}>
          {current !== null ? (
            <>
              <ClientDecision
                quotationId={quotation.id}
                number={quotation.number}
                current={current}
                reloadHref={path}
              />
              <Panel
                className={styles.detailPanel}
                title="Current revision"
                description={`Last changed ${when(current.updatedAt)}`}
                actions={<VersionDrawer number={quotation.number} rows={revisionRows(detail)} />}
              >
                <FactList facts={facts} className={styles.facts ?? ''} />
              </Panel>
              <Totals version={current} />
            </>
          ) : versions.length > 0 ? (
            <Panel
              className={styles.detailPanel}
              title="Revisions"
              actions={<VersionDrawer number={quotation.number} rows={revisionRows(detail)} />}
            >
              <p className={styles.note}>Open the list to see every revision.</p>
            </Panel>
          ) : null}
        </div>

        <div className={`${styles.stack} ${styles.historyStack}`}>
          <StatusHistory history={detail.statusHistory} versions={versions} />

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
            </ul>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
