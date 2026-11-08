// Email templates: turns a template name plus a few plain values into { subject, text, html }.
// Serves the Security NFR (Non-Functional Requirement: a measurable quality target): an email is read in
// places we do not control, so it never carries a secret, a token or a file link. The rules are enforced
// here in code, not left to each caller:
//   - only the variables a template lists are used, and any key that looks like a secret is refused;
//   - every value is HTML-escaped (and stripped of line breaks, so it cannot add a header or a fake line);
//   - the only link is WORKSPACE_PUBLIC_URL + /inbox/... or /memos/..., which needs a login to open.
// Keep the wording short and neutral: the email says "something needs you", the workspace shows the detail.

/** Every email the platform can send. Mirrors the union in the P1 plan, section 6.2. */
export const EMAIL_TEMPLATES = [
  'approval.pending',
  'approval.reminder',
  'approval.escalated',
  'approval.decided',
  'approval.blocked',
  'document.infected',
  'outbox.dead_letter',
] as const;
export type EmailTemplate = (typeof EMAIL_TEMPLATES)[number];

/**
 * The variables each template reads. A caller passing another key has it ignored (never rendered), so a
 * new field cannot reach an inbox until someone adds it here and reviews the wording.
 * `linkPath` is on every template: a workspace path such as /inbox/<id> (see buildLink).
 */
export const EMAIL_TEMPLATE_VARS = {
  'approval.pending': ['documentNumber', 'documentType', 'requesterName', 'linkPath'],
  'approval.reminder': ['documentNumber', 'documentType', 'requesterName', 'linkPath'],
  'approval.escalated': [
    'documentNumber',
    'documentType',
    'requesterName',
    'escalatedFromName',
    'linkPath',
  ],
  'approval.decided': ['documentNumber', 'documentType', 'decision', 'deciderName', 'linkPath'],
  'approval.blocked': ['documentNumber', 'documentType', 'reason', 'linkPath'],
  'document.infected': ['filename', 'linkPath'],
  'outbox.dead_letter': ['failedTemplate', 'attempts', 'linkPath'],
} as const satisfies Record<EmailTemplate, readonly string[]>;

export type EmailVars = Readonly<Record<string, string | undefined>>;
export type RenderedEmail = { subject: string; text: string; html: string };

/** A template, a variable or a link broke a rule above. Thrown at enqueue time, so the bug shows in the caller. */
export class EmailTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmailTemplateError';
  }
}

/** What an absent or empty variable turns into, so a half-filled caller still produces a sensible email. */
const NEUTRAL_DEFAULTS: Readonly<Record<string, string>> = {
  documentNumber: 'a document',
  documentType: 'document',
  requesterName: 'a colleague',
  deciderName: 'an approver',
  escalatedFromName: 'the assigned approver',
  decision: 'updated',
  reason: 'open the request for details',
  filename: 'a file',
  failedTemplate: 'an email',
  attempts: 'several',
  linkPath: '/inbox/',
};

/** Keys that must never travel in an email variable, whatever the template. */
const FORBIDDEN_KEY = /token|secret|password|signature/i;

/** Long values (a pasted comment, a filename) are cut so an email stays a notice, not a document. */
const MAX_VALUE_LENGTH = 200;

/** /inbox/<id> or /memos/<id>: letters, digits and . _ ~ - only. No query, fragment, scheme or dot segments. */
const LINK_PATH = /^\/(?:inbox|memos)\/[A-Za-z0-9._~-]*(?:\/[A-Za-z0-9._~-]+)*$/;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** WORKSPACE_PUBLIC_URL + path. The path must be inside the two login-protected areas, else it throws. */
export function buildLink(workspaceUrl: string, path: string): string {
  if (!/^https?:\/\/[^\s/]+/i.test(workspaceUrl)) {
    throw new EmailTemplateError('workspaceUrl must be an http(s) URL');
  }
  if (!LINK_PATH.test(path) || path.split('/').some((segment) => segment === '..')) {
    throw new EmailTemplateError('email link path must start with /inbox/ or /memos/');
  }
  return `${workspaceUrl.replace(/\/+$/, '')}${path}`;
}

/** One line, no control characters, capped. Used for every value before it is placed in any part. */
function clean(value: string): string {
  // Cc = control characters (CR, LF, NUL ...); Zl and Zp = the Unicode line and paragraph separators.
  const oneLine = value.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  return oneLine.length > MAX_VALUE_LENGTH ? `${oneLine.slice(0, MAX_VALUE_LENGTH - 1)}…` : oneLine;
}

type Parts = { subject: string; heading: string; lines: string[]; linkLabel: string };

/** The wording of each template, from already-cleaned values. Plain text; HTML is built from the same parts. */
function parts(template: EmailTemplate, v: Record<string, string>): Parts {
  const doc = `${v.documentType} ${v.documentNumber}`;
  switch (template) {
    case 'approval.pending':
      return {
        subject: `Approval needed: ${doc}`,
        heading: 'An approval is waiting for you',
        lines: [`${v.requesterName} asked you to review ${doc}.`],
        linkLabel: 'Open the request',
      };
    case 'approval.reminder':
      return {
        subject: `Reminder: approval needed for ${doc}`,
        heading: 'A reminder: still waiting for you',
        lines: [`${doc} from ${v.requesterName} is still waiting for your decision.`],
        linkLabel: 'Open the request',
      };
    case 'approval.escalated':
      return {
        subject: `Escalated: approval needed for ${doc}`,
        heading: 'An approval was escalated to you',
        lines: [
          `${doc} from ${v.requesterName} was waiting on ${v.escalatedFromName} and has now come to you.`,
        ],
        linkLabel: 'Open the request',
      };
    case 'approval.decided':
      return {
        subject: `${doc}: ${v.decision}`,
        heading: 'Your request has a decision',
        lines: [`${v.deciderName} marked ${doc} as ${v.decision}.`],
        linkLabel: 'See the decision',
      };
    case 'approval.blocked':
      return {
        subject: `Action needed: ${doc} is blocked`,
        heading: 'A request could not move forward',
        lines: [`${doc} is blocked: ${v.reason}.`],
        linkLabel: 'Open the request',
      };
    case 'document.infected':
      return {
        subject: 'A file was rejected by the virus scan',
        heading: 'A file was rejected',
        lines: [`The upload ${v.filename} failed the virus scan and was not saved.`],
        linkLabel: 'Open the workspace',
      };
    case 'outbox.dead_letter':
      return {
        subject: 'An email could not be delivered',
        heading: 'An email could not be delivered',
        lines: [
          `A ${v.failedTemplate} email failed after ${v.attempts} attempts and was given up on.`,
        ],
        linkLabel: 'Open the workspace',
      };
  }
}

/**
 * Renders one email. `opts.workspaceUrl` is WORKSPACE_PUBLIC_URL. Throws EmailTemplateError for a forbidden
 * variable key or a link path outside /inbox/ and /memos/.
 */
export function renderEmail(
  template: EmailTemplate,
  vars: EmailVars,
  opts: { workspaceUrl: string },
): RenderedEmail {
  if (!(EMAIL_TEMPLATES as readonly string[]).includes(template)) {
    throw new EmailTemplateError(`unknown email template: ${String(template)}`);
  }
  // Checked over every key the caller passed, including ones this template would ignore.
  for (const key of Object.keys(vars)) {
    if (FORBIDDEN_KEY.test(key)) {
      throw new EmailTemplateError(`email variable "${key}" is not allowed in an email`);
    }
  }

  const values: Record<string, string> = {};
  for (const key of EMAIL_TEMPLATE_VARS[template]) {
    const given = vars[key];
    const cleaned = typeof given === 'string' ? clean(given) : '';
    values[key] = cleaned === '' ? (NEUTRAL_DEFAULTS[key] ?? '') : cleaned;
  }

  // A bad linkPath throws here instead of being repaired: a wrong link is a bug in the caller.
  const link = buildLink(opts.workspaceUrl, values.linkPath ?? '/inbox/');
  const p = parts(template, values);
  const note = 'You need to sign in to Business OS to see the details.';

  const text = [p.heading, '', ...p.lines, '', `${p.linkLabel}: ${link}`, '', note].join('\n');
  const html = [
    '<!doctype html>',
    '<html><body style="font-family: sans-serif; line-height: 1.5; color: #1a1a1a;">',
    `<h2 style="font-size: 18px;">${escapeHtml(p.heading)}</h2>`,
    ...p.lines.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<p><a href="${escapeHtml(link)}">${escapeHtml(p.linkLabel)}</a></p>`,
    `<p style="color: #666; font-size: 13px;">${escapeHtml(note)}</p>`,
    '</body></html>',
  ].join('\n');

  return { subject: p.subject, text, html };
}
