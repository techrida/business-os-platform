// How a payment status and method look and read in the workspace, and which actions each status
// offers. Pure data and functions with no React import, so the list, the detail and the tests share
// them. Serves the NFR "the UI never shows data the contract does not promise": the filter accepts
// only the contract's statuses, and the action gate mirrors the contract's PAYMENT_TRANSITIONS.
import { PAYMENT_METHODS, PAYMENT_STATUSES, type PaymentStatus } from '@bos/contracts';

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'error';

export interface PaymentStatusMeta {
  label: string;
  tone: StatusTone;
}

/** A full record, so a status added to the contract is a compile error here until it is worded. */
const META: Record<PaymentStatus, PaymentStatusMeta> = {
  submitted: { label: 'Awaiting verification', tone: 'warning' },
  verified: { label: 'Verified', tone: 'success' },
  rejected: { label: 'Rejected', tone: 'error' },
  withdrawn: { label: 'Withdrawn', tone: 'neutral' },
  reversed: { label: 'Reversed', tone: 'error' },
};

export function paymentStatusMeta(status: PaymentStatus): PaymentStatusMeta {
  return META[status];
}

export const PAYMENT_STATUS_OPTIONS: readonly { value: PaymentStatus; label: string }[] =
  PAYMENT_STATUSES.map((value) => ({ value, label: META[value].label }));

export interface PaymentActions {
  verify: boolean;
  reject: boolean;
  reverse: boolean;
}

/**
 * Which buttons to offer. This only hides what cannot work in this status; whether the person may
 * do it (a Finance role, a different person from the one who recorded it) is the server's call and
 * its refusal is shown in words.
 */
export function actionsFor(status: PaymentStatus): PaymentActions {
  return {
    verify: status === 'submitted',
    reject: status === 'submitted',
    reverse: status === 'verified',
  };
}

const METHODS: Record<string, string> = {
  bank_transfer: 'Bank transfer',
  qr: 'QR payment',
  wire: 'Wire transfer',
  cheque: 'Cheque',
  cash: 'Cash',
};

/** The method in words; an unknown value from a newer API is shown as it came. */
export function methodLabel(method: string): string {
  return Object.hasOwn(METHODS, method) ? (METHODS[method] ?? method) : method;
}

/** The method filter's options, in the contract's order. */
export const PAYMENT_METHOD_OPTIONS: readonly { value: string; label: string }[] =
  PAYMENT_METHODS.map((value) => ({ value, label: methodLabel(value) }));
