// Pure helpers the kernel screens share (inbox, memos, bell). Safe for Client Components: no
// server-only imports and no runtime imports from the contracts, so the browser bundle stays small.
// Serves the NFR "errors name the problem and the recovery": one place turns an API failure into
// words a person can act on, so every screen says the same thing.

/** What a screen needs to know about a failed API call. */
export interface Failure {
  /** Plain words for the user. */
  message: string;
  /** True when the page the user is on is out of date and should be reloaded. */
  reload: boolean;
  /**
   * True when the API gave a definite answer (a 4xx). Then a retry is a new decision and gets a
   * fresh idempotency key. False for timeouts and 5xx, where the first call may have succeeded
   * and the same key must be sent again so it is not applied twice.
   */
  definite: boolean;
}

export type FailureContext = 'approval' | 'submit' | 'upload' | 'remove' | 'generic';

export interface FailureInput {
  status: number;
  code?: string | undefined;
  reason?: string | undefined;
  /** The API's own message, shown only for 400 where it names the field that is wrong. */
  detail?: string | undefined;
}

const FORBIDDEN_REASONS: Record<string, string> = {
  separation_of_duties: "You prepared this document, so you can't approve it.",
  no_permission: "Your roles don't allow this action. Ask an administrator if you need it.",
  out_of_scope: 'This record belongs to an area you cannot access.',
  mfa_required: 'This action needs a second sign-in step (MFA). Sign in again with it, then retry.',
  inactive_user: 'Your account is not active. Ask an administrator to restore it.',
};

/** What a 409 means when the API names its cause, so the user is not told to reload for no reason. */
const CONFLICT_CODES: Record<string, string> = {
  duplicate_pan_vat: 'Another customer already has this PAN/VAT number.',
  primary_contact_exists: 'This customer already has a primary contact.',
  kyb_not_verified: "This customer's verification must be approved first.",
  contact_activity_required: 'Log a call, email or meeting before moving this lead to Contacted.',
};

/** Turns an API status, code and 403 reason into the sentence the user sees. */
export function describeFailure(input: FailureInput, context: FailureContext = 'generic'): Failure {
  const { status, reason } = input;
  const definite = status >= 400 && status < 500 && status !== 408 && status !== 429;
  let message: string;
  let reload = false;

  if (status === 401) {
    message = 'Your session ended. Sign in again to continue.';
  } else if (status === 403) {
    message =
      (reason !== undefined ? FORBIDDEN_REASONS[reason] : undefined) ??
      "You don't have permission to do this.";
  } else if (status === 404) {
    message = 'We could not find that item. It may have been removed.';
  } else if (status === 409) {
    const named =
      input.code !== undefined && Object.hasOwn(CONFLICT_CODES, input.code)
        ? CONFLICT_CODES[input.code]
        : undefined;
    if (named !== undefined) {
      message = named;
    } else if (context === 'approval') {
      message = 'This request changed since you opened it.';
      reload = true;
    } else if (context === 'submit') {
      if (reason === 'stale_memo') {
        message = 'This memo changed. Reload it and review the latest version before submitting.';
        reload = true;
      } else {
        message =
          'Every attachment must finish its virus scan and come back clean before you can submit. Wait for the scan to finish, then try again.';
      }
    } else if (context === 'upload') {
      message = 'This memo can no longer take attachments because it is not a draft.';
    } else if (context === 'remove') {
      message =
        'Attachments can no longer be removed because this memo is no longer a draft or returned.';
      reload = true;
    } else {
      message = 'This item changed since you opened it. Reload and try again.';
      reload = true;
    }
  } else if (status === 411 || status === 400) {
    message =
      input.detail !== undefined && status === 400
        ? `The platform did not accept this: ${input.detail}`
        : 'The platform did not accept this request. Check what you entered and try again.';
  } else if (status === 413) {
    message = 'That file is larger than 25 MB.';
  } else if (status === 415) {
    message =
      'That file type is not accepted. Use PDF, PNG, JPEG, WebP, Word, Excel, PowerPoint or CSV.';
  } else if (status === 503 && input.code === 'db_busy') {
    message = 'Busy, please try again.';
  } else {
    message = 'The platform did not respond. Nothing was lost; try again in a moment.';
  }
  return { message, reload, definite };
}

/** The API's text for D44 (`currencyNotEnabled` in the API). Anchored, so no other 422 matches. */
const NOT_ENABLED_TEXT = /^Currency ([A-Z]{3}) is not enabled for this company$/;
const CURRENCY_CODE = /^[A-Z]{3}$/;

/**
 * The words for the API's 422 "currency not enabled" refusal (D44: the company switched the currency
 * off, perhaps after the page loaded), or undefined for any other failure. Reads the `ApiError` shape
 * (`status`, `body`) without importing it, so this file stays free of server-only code. The API names
 * the refusal `CURRENCY_NOT_ENABLED` with `details.currency`, but its error filter passes that code
 * only once it is on its 422 list; until then the body says `bad_request` and the currency is only in
 * the message, so both shapes are read. Only a three-letter code is echoed.
 */
export function currencyNotEnabledText(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const { status, body } = err as { status?: unknown; body?: unknown };
  if (status !== 422 || typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message, details } = error as {
    code?: unknown;
    message?: unknown;
    details?: unknown;
  };
  const fromText = typeof message === 'string' ? NOT_ENABLED_TEXT.exec(message)?.[1] : undefined;
  if (code !== 'CURRENCY_NOT_ENABLED' && fromText === undefined) return undefined;
  const fromDetails =
    typeof details === 'object' && details !== null
      ? (details as { currency?: unknown }).currency
      : undefined;
  const currency =
    typeof fromDetails === 'string' && CURRENCY_CODE.test(fromDetails) ? fromDetails : fromText;
  return `${currency ?? 'This currency'} is switched off for your company. Choose another currency, or ask an administrator to switch it on in Settings.`;
}

/**
 * Returns `raw` only when it is a same-origin path: one leading `/`, no second `/`, no backslash
 * and no control characters. A notification link comes from the database, but it ends up in an
 * `href`, so a `//host` or `javascript:` value must never get through.
 */
export function safeLocalPath(raw: string): string | null {
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  for (const ch of raw) {
    const code = ch.charCodeAt(0);
    if (ch === '\\' || code < 0x20 || (code >= 0x7f && code <= 0x9f)) return null;
  }
  return raw;
}

const ACRONYMS = new Set(['npr', 'inr', 'usd', 'id', 'fx', 'sla', 'vat', 'pan', 'ip']);

/** `amountNpr` becomes `Amount NPR`, `fx_rate` becomes `Fx rate`; known acronyms are upper-cased. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_.-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w !== '');
  return words
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(' ');
}

/** `12 KB`, `3.4 MB`: binary units, one decimal from 1 MB up, so the 25 MiB cap reads `25.0 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
};

/**
 * The type to declare for an upload. Browsers report `.csv` as `application/vnd.ms-excel` on
 * Windows and leave `type` empty for unknown files, so a known extension wins.
 */
export function guessMime(filename: string, browserType: string): string {
  const ext = filename.includes('.') ? filename.split('.').pop()?.toLowerCase() : undefined;
  const byExt = ext !== undefined ? MIME_BY_EXTENSION[ext] : undefined;
  return byExt ?? (browserType !== '' ? browserType : 'application/octet-stream');
}

export interface ScanLabel {
  text: string;
  tone: 'good' | 'wait' | 'bad';
}

/** What a document version's scan status means to the person holding the memo. */
export function scanLabel(status: string): ScanLabel {
  switch (status) {
    case 'clean':
      return { text: 'Scan passed', tone: 'good' };
    case 'quarantined':
      return { text: 'Scanning', tone: 'wait' };
    case 'awaiting_content':
      return { text: 'Waiting for upload', tone: 'wait' };
    case 'infected':
      return { text: 'Virus found', tone: 'bad' };
    case 'rejected':
      return { text: 'File rejected', tone: 'bad' };
    default:
      return { text: 'Scan failed', tone: 'bad' };
  }
}

/** Poll while a file is still being scanned or has not finished arriving. */
export function needsPolling(statuses: readonly string[]): boolean {
  return statuses.some((s) => s === 'quarantined' || s === 'awaiting_content');
}

/** What the browser needs to draw one attachment: no hashes, no uploader id, nothing it cannot use. */
export interface AttachmentView {
  id: string;
  documentId: string;
  filename: string;
  detectedMime?: string;
  sizeBytes: number;
  status: string;
}

export function toAttachmentView(v: {
  id: string;
  documentId: string;
  filename: string;
  detectedMime?: string | null;
  sizeBytes: number;
  status: string;
}): AttachmentView {
  return {
    id: v.id,
    documentId: v.documentId,
    filename: v.filename,
    ...(v.detectedMime ? { detectedMime: v.detectedMime } : {}),
    sizeBytes: v.sizeBytes,
    status: v.status,
  };
}

/** The file name from the `x-file-name` header (percent-encoded by the browser code), or null if malformed. */
export function decodeFileName(header: string | null): string | null {
  if (header === null || header === '') return null;
  try {
    return decodeURIComponent(header);
  } catch {
    return null;
  }
}

/** `text/csv; charset=utf-8` becomes `text/csv`. */
export function baseMime(contentType: string | null): string {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

const AUDIT_EVENT_LABELS: Record<string, string> = {
  'test_memos.insert': 'Memo created',
  'test_memos.update': 'Memo updated',
  'test_memos.delete': 'Memo deleted',
  'memo.submitted': 'Memo submitted',
  'approvals.submit': 'Submitted for approval',
  'approval_requests.insert': 'Approval requested',
  'approval_requests.update': 'Approval request updated',
  'approval_steps.insert': 'Approval step added',
  'approval_steps.update': 'Approval step updated',
  'approval_actions.insert': 'Approval decision recorded',
  'approvals.approve': 'Approved',
  'approvals.return': 'Returned for changes',
  'approvals.reject': 'Rejected',
  'approvals.cancel': 'Approval cancelled',
  'approvals.escalate': 'Escalated after the deadline',
  'approvals.remind': 'Reminder sent',
  'approvals.reroute': 'Route recalculated',
  'approvals.block': 'Approval blocked',
  'documents.insert': 'Attachment added',
  'document_versions.insert': 'Attachment version added',
  'document.scanned': 'Attachment scanned',
  'document.removed': 'Attachment removed',
};

/**
 * An audit event name in plain language: `test_memos.update` becomes `Memo updated`. A name this table does
 * not know falls back to its humanised form (`approval_steps.skip` becomes `Approval steps skip`), so a new
 * event is still readable and is never hidden.
 */
export function auditEventLabel(action: string): string {
  const known = AUDIT_EVENT_LABELS[action.trim().toLowerCase()];
  if (known !== undefined) return known;
  const humanised = humanizeKey(action.replace(/^test_memos?[.]/, 'memo.'));
  return humanised === '' ? 'Event' : humanised;
}
