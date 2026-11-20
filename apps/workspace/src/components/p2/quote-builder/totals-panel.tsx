import { formatMoney, type NumberSystems } from '@bos/locale';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useNumberSystems } from '@/components/ui/number-system-context';
import { Panel } from '@/components/ui/panel';

import type { Currency } from './model';
import type { PreviewResult } from './schemas';
import styles from './quote-builder.module.css';

/**
 * What the totals area is doing. `ready` and `loading` carry a server result; the others carry
 * only a message, so no amount can be shown that the server did not return. `starting` is the page
 * as the server sent it, before its script runs: nothing has been asked yet.
 */
export type PreviewState = 'starting' | 'needs_save' | 'incomplete' | 'loading' | 'ready' | 'error';

export interface TotalsPanelProps {
  currency: Currency;
  state: PreviewState;
  preview?: PreviewResult | null | undefined;
  /** Explains `needs_save`, `incomplete` and `error`. */
  message?: string | undefined;
  /** This page's address: a plain link to load it again, which works even if its script did not. */
  reloadHref?: string | undefined;
  /** Asks for the totals again after an error. */
  onRetry?: (() => void) | undefined;
}

const money =
  (numberSystems: NumberSystems) =>
  (amount: string, currency: Currency): string =>
    formatMoney(amount, currency, { numberSystems });

/**
 * Section 7: totals and tax summary. Presentation only. Every figure is a string the preview
 * endpoint returned, formatted with `formatMoney`; nothing is added, multiplied or rounded here
 * (the NFR "amounts are exact" lives on the server). While a new preview is on the way the last
 * server figures stay visible, marked as updating, so the panel does not flash empty on each key.
 */
export function TotalsPanel({
  currency,
  state,
  preview,
  message,
  reloadHref,
  onRetry,
}: TotalsPanelProps) {
  const fmt = money(useNumberSystems());
  const shown = (state === 'ready' || state === 'loading') && preview ? preview : null;
  const t = shown?.totals;

  return (
    <Panel as="aside" title="Totals" className={styles.totals} tabIndex={0}>
      {state === 'loading' ? (
        <p role="status" className={styles.updating}>
          Updating totals
        </p>
      ) : null}

      {shown && t ? (
        <div className={state === 'loading' ? styles.stale : undefined}>
          <dl className={styles.totalList}>
            <div className={styles.totalRow}>
              <dt>Subtotal</dt>
              <dd>{fmt(t.subtotal, currency)}</dd>
            </div>
            <div className={styles.totalRow}>
              <dt>Discount ({t.effectiveDiscountPct}%)</dt>
              <dd>{fmt(t.discountAmount, currency)}</dd>
            </div>
            <div className={styles.totalRow}>
              <dt>Taxable amount</dt>
              <dd>{fmt(t.taxableAmount, currency)}</dd>
            </div>
            <div className={styles.totalRow}>
              <dt>Tax</dt>
              <dd>{fmt(t.taxAmount, currency)}</dd>
            </div>
            <div className={`${styles.totalRow} ${styles.grand}`}>
              <dt>Grand total</dt>
              <dd>{fmt(t.total, currency)}</dd>
            </div>
          </dl>

          {shown.taxSummary.length > 0 ? (
            <div className={styles.taxSummary}>
              <h3 className={styles.subhead}>Tax summary</h3>
              <ul className={styles.plainList}>
                {shown.taxSummary.map((row) => (
                  <li key={row.taxCodeId} className={styles.taxRow}>
                    <span className={styles.taxLabel}>
                      {row.label} <span className={styles.muted}>on {fmt(row.base, currency)}</span>
                    </span>
                    <span className={styles.num}>{fmt(row.tax, currency)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {shown.nprSnapshot ? (
            <p className={styles.npr}>
              In NPR: <span className={styles.num}>{fmt(shown.nprSnapshot.amountNpr, 'NPR')}</span>
              <span className={styles.muted}>
                {' '}
                at {shown.nprSnapshot.rate} ({shown.nprSnapshot.rateSource},{' '}
                {shown.nprSnapshot.rateDate})
              </span>
            </p>
          ) : null}
        </div>
      ) : state === 'error' ? (
        <Alert
          tone="error"
          role="alert"
          actions={
            onRetry ? (
              <Button size="small" variant="secondary" onClick={onRetry}>
                Try again
              </Button>
            ) : null
          }
        >
          {message ?? 'The totals could not be worked out. Try again in a moment.'}
          {/* Try again is a server action, and Next runs those one at a time: behind a request that
              hangs it waits too. A full reload is the way out, so the error offers one. */}
          {reloadHref ? (
            <>
              {' '}
              If that does not help, <a href={reloadHref}>reload the page</a>.
            </>
          ) : null}
        </Alert>
      ) : state === 'starting' ? (
        <p className={styles.muted}>
          The totals appear once the page has finished loading.
          {reloadHref ? (
            <>
              {' '}
              If they do not, <a href={reloadHref}>reload the page</a>.
            </>
          ) : null}
        </p>
      ) : state === 'loading' ? (
        <div className={styles.skeletons} aria-hidden="true">
          <span className={styles.skeleton} />
          <span className={styles.skeleton} />
          <span className={styles.skeleton} />
        </div>
      ) : (
        <p className={styles.muted}>
          {message ??
            (state === 'needs_save'
              ? 'Save the draft to see the totals.'
              : 'Complete every line to see the totals.')}
        </p>
      )}
    </Panel>
  );
}
