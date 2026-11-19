import type {
  PortalDisplay,
  VendorPortalCapability,
  VendorPortalPurchaseOrderView,
  VendorVisiblePoStatus,
} from '@bos/contracts';

import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { ViewDocument } from '@/components/ui/document-viewer';
import { displayFormat } from '@/lib/display';

import styles from './vendor.module.css';
import { PO_STATUS_LOOK, trimQuantity } from './vendor-status';

/** Orders a bill can still be raised against: closed, short-closed and cancelled ones take none. */
const BILLABLE: ReadonlySet<VendorVisiblePoStatus> = new Set([
  'issued',
  'partially_received',
  'fully_received',
]);

/**
 * One issued purchase order as the vendor sees it. It reads only `VendorPortalPurchaseOrderView`
 * (a strict allow-list), and every figure is the server's: the order total and the unit prices
 * are formatted, never worked out here, and there is no per-line amount because the contract has
 * none. The PDF is a plain anchor to a route handler: a prefetch would fetch the file, and the
 * API sends it as an attachment, so an error reads as text.
 *
 * Submit a bill shows only to a vendor with full access (`capability`, from the onboarding read):
 * a suspended (`read_only`) or not yet approved vendor would land on the no-access notice. Null
 * (the read failed) hides it too.
 */
export function PurchaseOrderView({
  view,
  display,
  capability,
}: {
  view: VendorPortalPurchaseOrderView;
  display?: PortalDisplay;
  capability: VendorPortalCapability | null;
}) {
  const { money: formatAmount, day } = displayFormat(display);
  const canBill = capability === 'full' && BILLABLE.has(view.status);
  const look = PO_STATUS_LOOK[view.status];
  const money = (amount: string) => formatAmount(amount, view.currency);
  return (
    <div className={styles.document}>
      <header className={styles.docHead}>
        <div className={styles.titleRow}>
          <h1 className={styles.docTitle}>
            {view.number} <span className={styles.version}>Version {view.version}</span>
          </h1>
          <Badge tone={look.tone}>{look.label}</Badge>
        </div>
        <dl className={styles.facts}>
          <div>
            <dt>Issued</dt>
            <dd>{day(view.issueDate)}</dd>
          </div>
          <div>
            <dt>Payment terms</dt>
            <dd>{view.paymentTermsDays} days</dd>
          </div>
          <div>
            <dt>Total</dt>
            <dd className={styles.factTotal}>{money(view.total)}</dd>
          </div>
        </dl>
        {view.file ? (
          <div className={styles.download}>
            <ViewDocument
              name={view.file.filename}
              previewUrl={`/vendor/purchase-orders/${view.id}/pdf/preview`}
              downloadUrl={`/vendor/purchase-orders/${view.id}/pdf`}
              variant="secondary"
              size="small"
              withDownload
              describedBy="po-file-name"
            />
            <span id="po-file-name" className={styles.fileName}>
              {view.file.filename}
            </span>
          </div>
        ) : (
          <p className={styles.muted}>
            The PDF is not ready yet. Please check back in a few minutes.
          </p>
        )}
        {canBill ? (
          <div className={styles.download}>
            <LinkButton href={`/vendor/bills/new?po=${encodeURIComponent(view.id)}`}>
              Submit a bill
            </LinkButton>
          </div>
        ) : null}
      </header>

      <section aria-labelledby="po-lines-heading" className={styles.section}>
        <h2 id="po-lines-heading" className={styles.sectionTitle}>
          Items
        </h2>
        <div className={styles.tableFrame}>
          <table className={styles.table}>
            <caption className={styles.visuallyHidden}>Items on {view.number}</caption>
            <thead>
              <tr>
                <th scope="col">No.</th>
                <th scope="col">Description</th>
                <th scope="col">Unit</th>
                <th scope="col" className={styles.num}>
                  Ordered
                </th>
                <th scope="col" className={styles.num}>
                  Received
                </th>
                <th scope="col" className={styles.num}>
                  Unit price
                </th>
              </tr>
            </thead>
            <tbody>
              {view.lines.map((line) => (
                <tr key={line.lineNo}>
                  <td className={styles.nowrap}>{line.lineNo}</td>
                  <td className={styles.description}>{line.description}</td>
                  <td>{line.uom}</td>
                  <td className={styles.num}>{trimQuantity(line.quantity)}</td>
                  <td className={styles.num}>{trimQuantity(line.receivedQuantity)}</td>
                  <td className={`${styles.num} ${styles.nowrap}`}>{money(line.unitPrice)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
