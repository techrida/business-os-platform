import type { CustomerQuotationView, CustomerVisibleStatus } from '@bos/contracts';
import { formatCustomerDate } from '@bos/locale';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

/** How a status reads to the customer. `sent` is the one that asks something of them. */
export const STATUS_LOOK: Record<CustomerVisibleStatus, { label: string; tone: Tone }> = {
  sent: { label: 'Awaiting your response', tone: 'info' },
  accepted: { label: 'Accepted', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'error' },
  expired: { label: 'Expired', tone: 'warning' },
  superseded: { label: 'Replaced by a newer revision', tone: 'neutral' },
};

/**
 * The status as the customer should read it today. A sent quotation whose valid-until day has
 * passed reads as expired even before the API's expiry job has caught up.
 */
export function displayStatus(
  status: CustomerVisibleStatus,
  validUntil: string,
  today: string,
): CustomerVisibleStatus {
  return status === 'sent' && isPastValidUntil(validUntil, today) ? 'expired' : status;
}

/** Today's calendar date in Kathmandu, as `YYYY-MM-DD`. */
export function todayInKathmandu(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kathmandu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** A quotation is valid through its valid-until day. ISO dates compare correctly as strings. */
export function isPastValidUntil(validUntil: string, today: string): boolean {
  return validUntil < today;
}

export { formatCustomerDate as formatDay };

export type Respondability = { open: true } | { open: false; expired: boolean; reason: string };

/**
 * Whether the customer may accept or reject now. Only a sent, unexpired quotation is open. The
 * API decides in the end; this keeps the buttons honest and says why they are off.
 */
export function canRespond(view: CustomerQuotationView, today: string): Respondability {
  if (
    view.status === 'expired' ||
    (view.status === 'sent' && isPastValidUntil(view.validUntil, today))
  ) {
    return {
      open: false,
      expired: true,
      reason: `This quotation expired on ${formatCustomerDate(view.validUntil, view.display.dateFormat)}, so it can no longer be accepted. Contact the person who sent it to ask for a new one.`,
    };
  }
  if (view.status === 'sent') return { open: true };
  const reason: Record<Exclude<CustomerVisibleStatus, 'sent' | 'expired'>, string> = {
    accepted: 'You have accepted this quotation. No further response is needed.',
    rejected: 'You have rejected this quotation. No further response is needed.',
    superseded:
      'A newer revision of this quotation replaces this one. Open your quotations to find it.',
  };
  return { open: false, expired: false, reason: reason[view.status] };
}
