// Turns an API failure into words and a kind the builder can act on. Pure (no server-only import),
// so it can be tested and used from the actions.

export type FailureKind =
  | 'stale' // the row version moved: reload
  | 'stale_fx' // the exchange rate is older than the allowed window
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'session'
  | 'error';

export interface QuoteFailure {
  kind: FailureKind;
  message: string;
}

interface ErrorLike {
  status: number;
  body?: unknown;
}

function errorFields(body: unknown): { code: string; message: string; reason: string } {
  const e = (body as { error?: Record<string, unknown> } | null | undefined)?.error;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  return { code: s(e?.code), message: s(e?.message), reason: s(e?.reason) };
}

const FORBIDDEN: Record<string, string> = {
  separation_of_duties: 'You prepared this quotation, so you cannot approve it.',
  no_permission: "Your roles don't allow this. Ask an administrator if you need it.",
  out_of_scope: 'This quotation belongs to an area you cannot access.',
  mfa_required: 'This action needs a second sign-in step (MFA). Sign in again with it, then retry.',
  inactive_user: 'Your account is not active. Ask an administrator to restore it.',
};

export const STALE_FX_MESSAGE =
  'The exchange rate for this currency is older than 7 days, so the quotation cannot be priced or submitted. Ask Finance to enter today’s rate, then try again. Your changes are still here.';

export const STALE_VERSION_MESSAGE =
  'Someone else changed this quotation after you opened it. Reload to see the latest version. Your unsaved edits on this page will be lost, so copy anything you need first.';

/** A 409 about the exchange rate, told apart from a stale row version by the API's code or text. */
function isFxConflict(f: { code: string; message: string }): boolean {
  return /fx|exchange|rate_stale|stale_rate/i.test(`${f.code} ${f.message}`);
}

export function describeQuoteFailure(
  err: unknown,
  action: 'save' | 'preview' | 'submit' | 'load',
): QuoteFailure {
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number((err as ErrorLike).status)
      : 0;
  const f = errorFields((err as ErrorLike | null)?.body);

  if (status === 401) {
    return { kind: 'session', message: 'Your session ended. Sign in again to continue.' };
  }
  if (status === 403) {
    return {
      kind: 'forbidden',
      message: FORBIDDEN[f.reason] ?? "You don't have permission to do this.",
    };
  }
  if (status === 404) {
    return {
      kind: 'not_found',
      message: 'We could not find this quotation. It may have been removed.',
    };
  }
  if (status === 409) {
    return isFxConflict(f)
      ? { kind: 'stale_fx', message: STALE_FX_MESSAGE }
      : { kind: 'stale', message: STALE_VERSION_MESSAGE };
  }
  if (status === 400 || status === 422) {
    return {
      kind: 'invalid',
      message:
        status === 400 && f.message !== ''
          ? `The platform did not accept this: ${f.message}`
          : 'The platform did not accept this quotation. Check the highlighted fields and try again.',
    };
  }
  const what: Record<typeof action, string> = {
    preview: 'The totals could not be worked out',
    submit: 'Nothing was submitted',
    save: 'Nothing was saved',
    load: 'This page could not be loaded',
  };
  return {
    kind: 'error',
    message: `The platform did not respond. ${what[action]}; try again in a moment.`,
  };
}
