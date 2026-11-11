// Turns an API failure into words for the payment and receivable screens. Pure (no server-only
// import), so actions, components and tests can all use it. The kernel's generic wording is not used
// here: it would call OVER_ALLOCATION "changed since you opened it" and a self-verification refusal
// "you can't approve it". Serves the NFR "errors name the problem and the recovery".

export type PaymentFailureKind =
  | 'self_verification'
  | 'over_allocation'
  | 'mismatched_items'
  | 'in_progress'
  | 'stale'
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'session'
  | 'unavailable';

export interface PaymentFailure {
  kind: PaymentFailureKind;
  message: string;
  /** True when the page is out of date and the person should reload it. */
  reload: boolean;
  /**
   * True when the API gave a final answer. The next try is then a new decision with a new
   * idempotency key. False for timeouts, 5xx and the "first request still running" 409: the first
   * call may have landed, so the same key must go again.
   */
  definite: boolean;
  status: number;
}

interface Fields {
  code: string;
  reason: string;
  message: string;
}

function fieldsOf(body: unknown): Fields {
  const e = (body as { error?: Record<string, unknown> } | null | undefined)?.error;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return { code: s(e?.code), reason: s(e?.reason), message: s(e?.message) };
}

const FORBIDDEN_REASONS: Record<string, string> = {
  no_permission: "Your roles don't allow this. Ask an administrator if you need it.",
  out_of_scope: 'This payment belongs to an area you cannot access.',
  mfa_required: 'This action needs a second sign-in step (MFA). Sign in again with it, then retry.',
  inactive_user: 'Your account is not active. Ask an administrator to restore it.',
};

export const SELF_VERIFICATION_MESSAGE =
  'You recorded this payment, so someone else in Finance must verify it. Ask a colleague to open it and verify.';

export const OVER_ALLOCATION_MESSAGE =
  'These amounts are more than this payment has left, or more than an invoice has open. Nothing was allocated. Check the amounts and try again.';

export const MISMATCHED_ITEMS_MESSAGE =
  'One of the invoices belongs to another customer or currency than this payment, or is no longer open. Nothing was allocated. Reload to see what is open, then choose again.';

export const STALE_MESSAGE =
  'This payment changed after you opened it. Someone else may have verified, rejected or reversed it. Reload to see where it stands.';

export const UNAVAILABLE_MESSAGE =
  'The platform did not respond. Try again in a moment; if the action already went through, it will not be applied twice.';

/** The API's idempotency guard names the header in its message; its code is the generic `conflict`. */
function isInProgress(f: Fields): boolean {
  return /idempotency-key/i.test(f.message);
}

export function describePaymentFailure(err: unknown): PaymentFailure {
  const status =
    typeof err === 'object' && err !== null && 'status' in err ? Number(err.status) : 0;
  const f = fieldsOf(
    typeof err === 'object' && err !== null && 'body' in err ? err.body : undefined,
  );
  const definite = status >= 400 && status < 500 && status !== 408 && status !== 429;
  const make = (
    kind: PaymentFailureKind,
    message: string,
    over: Partial<Pick<PaymentFailure, 'reload' | 'definite'>> = {},
  ): PaymentFailure => ({ kind, message, reload: false, definite, status, ...over });

  if (status === 401) return make('session', 'Your session ended. Sign in again to continue.');
  if (status === 403) {
    if (f.reason === 'separation_of_duties') {
      return make('self_verification', SELF_VERIFICATION_MESSAGE);
    }
    return make(
      'forbidden',
      FORBIDDEN_REASONS[f.reason] ?? "You don't have permission to do this.",
    );
  }
  if (status === 404) {
    return make('not_found', 'We could not find this payment. It may have been removed.');
  }
  if (status === 409) {
    // Domain codes first: they are definite answers about the request itself, not about versions.
    if (f.code === 'OVER_ALLOCATION') return make('over_allocation', OVER_ALLOCATION_MESSAGE);
    if (isInProgress(f)) {
      return make('in_progress', 'Still saving. Wait a moment and try again.', {
        definite: false,
      });
    }
    return make('stale', STALE_MESSAGE, { reload: true });
  }
  if (status === 422 && f.code === 'MISMATCHED_ITEMS') {
    return make('mismatched_items', MISMATCHED_ITEMS_MESSAGE);
  }
  if (status === 400) {
    return make(
      'invalid',
      f.message !== ''
        ? `The platform did not accept this: ${f.message}`
        : 'The platform did not accept this. Check what you entered and try again.',
    );
  }
  if (definite) {
    // 422 and any other final 4xx.
    return make(
      'invalid',
      'The platform did not accept this. Check what you entered and try again.',
    );
  }
  return make('unavailable', UNAVAILABLE_MESSAGE, { definite: false });
}
