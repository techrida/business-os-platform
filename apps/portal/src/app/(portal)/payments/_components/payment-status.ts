import type { PaymentMethod, PaymentStatus } from '@bos/contracts';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

/** How a payment status reads to the customer. The status always comes from the server. */
export const PAYMENT_STATUS_LOOK: Record<PaymentStatus, { label: string; tone: Tone }> = {
  submitted: { label: 'Awaiting verification', tone: 'info' },
  verified: { label: 'Verified', tone: 'success' },
  rejected: { label: 'Not accepted', tone: 'error' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
  reversed: { label: 'Reversed', tone: 'warning' },
};

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  bank_transfer: 'Bank transfer',
  qr: 'QR payment',
  wire: 'Wire transfer',
  cheque: 'Cheque',
  cash: 'Cash',
};
