// Email templates: turns a template name plus a few plain values into { subject, text, html }.
// Serves the Security NFR (Non-Functional Requirement: a measurable quality target): an email is read in
// places we do not control, so it never carries a secret, a token or a file link. The rules are enforced
// here in code, not left to each caller:
//   - only the variables a template lists are used, and any key that looks like a secret is refused;
//   - every value is HTML-escaped (and stripped of line breaks, so it cannot add a header or a fake line);
//   - the only link is built from config, never from input: WORKSPACE_PUBLIC_URL for staff emails or
//     PORTAL_PUBLIC_URL for customer emails, plus a path from that template's own short list. Both need
//     a login to open;
//   - no attachment, ever (ADR 0023: email a portal link, never a file). A rendered email is only
//     { subject, text, html }, and assertSafeEmail refuses any other key, any image or file reference
//     and any host other than the one the template links to. The one exception is the company logo (R6Q20): a
//     single <img> whose address renderEmail builds itself, on the same host as the link, from the tenant and
//     logo ids (buildLogoUrl). assertSafeEmail accepts that exact tag and no other.
// Keep the wording short and neutral: the email says "something needs you", the workspace shows the detail.

import { formatCustomerDate } from '@bos/locale';

/** Every email the platform can send. Mirrors the union in the P1 plan, section 6.2. */
export const EMAIL_TEMPLATES = [
  'approval.pending',
  'approval.reminder',
  'approval.escalated',
  'approval.decided',
  'approval.blocked',
  'document.infected',
  'outbox.dead_letter',
  // P2 (kernel gap M15). The next three go to staff and link to the workspace.
  'quotation.accepted',
  'crm.assigned',
  'crm.follow_up_digest',
  // Customer-facing: these link to the portal, and need PORTAL_PUBLIC_URL.
  'quotation.sent',
  'quotation.expiring',
  'quotation.expired',
  'portal.invite',
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
  'quotation.accepted': ['quotationNumber', 'customerName', 'linkPath'],
  'crm.assigned': ['entityType', 'entityName', 'assignerName', 'linkPath'],
  'crm.follow_up_digest': ['dueCount', 'overdueCount', 'linkPath'],
  'quotation.sent': ['quotationNumber', 'customerName', 'validUntil', 'linkPath'],
  'quotation.expiring': ['quotationNumber', 'customerName', 'validUntil', 'linkPath'],
  'quotation.expired': ['quotationNumber', 'customerName', 'validUntil', 'linkPath'],
  'portal.invite': ['customerName', 'linkPath'],
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
  quotationNumber: 'for your request',
  customerName: 'your organization',
  validUntil: 'the date shown in the portal',
  entityType: 'record',
  entityName: 'a record',
  assignerName: 'a colleague',
  dueCount: '0',
  overdueCount: '0',
};

/** Keys that must never travel in an email variable, whatever the template. */
const FORBIDDEN_KEY = /token|secret|password|signature/i;

/** Long values (a pasted comment, a filename) are cut so an email stays a notice, not a document. */
const MAX_VALUE_LENGTH = 200;

type LinkBase = 'workspace' | 'portal';

const APPROVAL_LINK = {
  base: 'workspace',
  areas: ['inbox', 'memos'],
  fallback: '/inbox/',
} as const;
const PORTAL_QUOTATION_LINK = {
  base: 'portal',
  areas: ['quotations'],
  fallback: '/quotations/',
} as const;

/**
 * Where each template's one link may point. `base` picks WORKSPACE_PUBLIC_URL (staff) or
 * PORTAL_PUBLIC_URL (customer); `areas` are the first path segments it may use; `fallback` is the path
 * used when the caller gives none. Narrow on purpose: a new area is a reviewed change here.
 */
const TEMPLATE_LINKS: Record<
  EmailTemplate,
  { base: LinkBase; areas: readonly string[]; fallback: string }
> = {
  'approval.pending': APPROVAL_LINK,
  'approval.reminder': APPROVAL_LINK,
  'approval.escalated': APPROVAL_LINK,
  // The requester opens the decided document itself: a memo, or a quotation (ApprovalSubject.link).
  'approval.decided': { ...APPROVAL_LINK, areas: ['inbox', 'memos', 'quotations'] },
  'approval.blocked': APPROVAL_LINK,
  'document.infected': APPROVAL_LINK,
  'outbox.dead_letter': APPROVAL_LINK,
  'quotation.accepted': { base: 'workspace', areas: ['quotations'], fallback: '/quotations/' },
  // The workspace has no /crm page: work is opened on its own record (a lead, opportunity or quotation), and a
  // follow-up on a customer or contact on the follow-ups page.
  'crm.assigned': {
    base: 'workspace',
    areas: ['leads', 'opportunities', 'quotations', 'activities'],
    fallback: '/activities/',
  },
  'crm.follow_up_digest': { base: 'workspace', areas: ['activities'], fallback: '/activities/' },
  'quotation.sent': PORTAL_QUOTATION_LINK,
  'quotation.expiring': PORTAL_QUOTATION_LINK,
  'quotation.expired': PORTAL_QUOTATION_LINK,
  // The invite links to the sign-in page only: ZITADEL sends the account-activation step itself (K8),
  // so this email carries no invite token.
  'portal.invite': { base: 'portal', areas: ['sign-in'], fallback: '/sign-in/' },
};

const WORKSPACE_AREAS = [
  'inbox',
  'memos',
  'quotations',
  'leads',
  'opportunities',
  'activities',
] as const;
const PORTAL_AREAS = ['quotations', 'sign-in'] as const;

/** /<area>/<id>: letters, digits and . _ ~ - only. No query, fragment, scheme or dot segments. */
function linkPattern(areas: readonly string[]): RegExp {
  return new RegExp(`^/(?:${areas.join('|')})/[A-Za-z0-9._~-]*(?:/[A-Za-z0-9._~-]+)*$`);
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function joinLink(baseUrl: string, path: string, areas: readonly string[], what: string): string {
  if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) {
    throw new EmailTemplateError(`${what} must be an http(s) URL`);
  }
  if (!linkPattern(areas).test(path) || path.split('/').some((segment) => segment === '..')) {
    throw new EmailTemplateError(
      `email link path must start with ${areas.map((a) => `/${a}/`).join(' or ')}`,
    );
  }
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * WORKSPACE_PUBLIC_URL + path. The path must be inside a login-protected workspace area (`areas` narrows
 * it further, as each template does), else it throws.
 */
export function buildLink(
  workspaceUrl: string,
  path: string,
  areas: readonly string[] = WORKSPACE_AREAS,
): string {
  return joinLink(workspaceUrl, path, areas, 'workspaceUrl');
}

/** PORTAL_PUBLIC_URL + path, for customer emails. Only the portal's own areas are accepted. */
export function buildPortalLink(
  portalUrl: string,
  path: string,
  areas: readonly string[] = PORTAL_AREAS,
): string {
  return joinLink(portalUrl, path, areas, 'portalUrl');
}

/** One line, no control characters, capped. Used for every value before it is placed in any part. */
function clean(value: string): string {
  // Cc = control characters (CR, LF, NUL ...); Zl and Zp = the Unicode line and paragraph separators.
  const oneLine = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    // A value must not become a clickable link in a mail client. A scheme://, a www. name or a
    // javascript:, data: or cid: reference is replaced, so the only link is the one built from config.
    // A bare "example.com" can still be auto-linked by some clients; no rule can stop that without
    // damaging real names, so assertSafeEmail guards the parts we build instead.
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S*/gi, '[link removed]')
    .replace(/\bwww\.\S+/gi, '[link removed]')
    // Only the marker is replaced for the next two (the words after it are harmless), and they match
    // everything assertSafeEmail rejects, so a caller's text can never make a render throw.
    .replace(/\b(?:javascript|vbscript|data|cid)\s*:/gi, '[link removed]')
    .replace(/\b(?:src|href|action|formaction)\s*=/gi, '[link removed]')
    .trim();
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
    case 'quotation.accepted':
      return {
        subject: `Accepted: quotation ${v.quotationNumber}`,
        heading: 'A quotation was accepted',
        lines: [`${v.customerName} accepted quotation ${v.quotationNumber}.`],
        linkLabel: 'Open the quotation',
      };
    case 'crm.assigned':
      return {
        subject: `Assigned to you: ${v.entityType} ${v.entityName}`,
        heading: 'Something was assigned to you',
        lines: [`${v.assignerName} assigned the ${v.entityType} ${v.entityName} to you.`],
        linkLabel: 'Open it in the workspace',
      };
    case 'crm.follow_up_digest':
      return {
        subject: 'Your follow-ups for today',
        heading: 'Your follow-ups for today',
        lines: [`Due today: ${v.dueCount}. Overdue: ${v.overdueCount}.`],
        linkLabel: 'Open your follow-ups',
      };
    case 'quotation.sent':
      return {
        subject: `Quotation ${v.quotationNumber} is ready for you`,
        heading: 'A quotation is ready for you',
        lines: [
          `Hello ${v.customerName}, quotation ${v.quotationNumber} is ready to review. It is valid until ${formatCustomerDate(v.validUntil ?? '')}.`,
          'Nothing is attached to this email: open the portal to see the quotation.',
        ],
        linkLabel: 'View the quotation',
      };
    case 'quotation.expiring':
      return {
        subject: `Quotation ${v.quotationNumber} expires soon`,
        heading: 'A quotation is about to expire',
        lines: [
          `Quotation ${v.quotationNumber} for ${v.customerName} is valid until ${formatCustomerDate(v.validUntil ?? '')}.`,
        ],
        linkLabel: 'View the quotation',
      };
    case 'quotation.expired':
      return {
        subject: `Quotation ${v.quotationNumber} has expired`,
        heading: 'A quotation has expired',
        lines: [
          `Quotation ${v.quotationNumber} for ${v.customerName} was valid until ${formatCustomerDate(v.validUntil ?? '')} and can no longer be accepted.`,
        ],
        linkLabel: 'View the quotation',
      };
    case 'portal.invite':
      return {
        subject: 'You are invited to the customer portal',
        heading: 'You are invited to the customer portal',
        lines: [
          `An account was created for ${v.customerName}. You will receive a separate message to activate it.`,
          'If you did not expect this invitation, you can ignore this email.',
        ],
        linkLabel: 'Go to the portal sign-in',
      };
  }
}

/** The company logo to show at the top of an email: the tenant and the document id its public route takes. */
export interface EmailLogo {
  tenantId: string;
  documentId: string;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The absolute public address of the logo: the app's own URL plus `/brand/logo/<tenantId>/<documentId>`, the
 * same-origin route that serves the API's public logo. Built from config and two guids, never from caller text.
 */
export function buildLogoUrl(baseUrl: string, logo: EmailLogo): string {
  if (!/^https?:\/\/[^\s/]+/i.test(baseUrl)) {
    throw new EmailTemplateError('the logo base must be an http(s) URL');
  }
  if (!GUID.test(logo.tenantId) || !GUID.test(logo.documentId)) {
    throw new EmailTemplateError('the logo ids must be guids');
  }
  return `${baseUrl.replace(/\/+$/, '')}/brand/logo/${logo.tenantId.toLowerCase()}/${logo.documentId.toLowerCase()}`;
}

/** The one image tag an email may hold. The alt text is the (cleaned, escaped) company name, shown when images are off. */
function logoImg(url: string, alt: string): string {
  return `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" height="40" style="display: block; height: 40px; max-width: 200px; width: auto; border: 0; margin: 0 0 16px;">`;
}

const RENDERED_KEYS = 'html,subject,text';
const HTML_FORBIDDEN =
  /<\s*(?:img|iframe|object|embed|link|form|script|video|audio|source)\b|\bsrc\s*=/i;
const REFERENCE_FORBIDDEN = /\bcid:|\bdata:[a-z]+\/|\b(?:javascript|vbscript):/i;
/** A link with a scheme, anywhere in a part (text, html attribute or plain). */
const SCHEME_URL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
/** A protocol-relative link in an html attribute: href="//host/path". */
const RELATIVE_URL_ATTR = /\b(?:href|action|formaction)\s*=\s*["']?(\/\/[^\s"'<>]+)/gi;

/**
 * The last line of defence, run on every rendered email: it throws unless the email is exactly
 * { subject, text, html }, has no image, file or script reference, and every link points at one of
 * `allowedHosts` (host with port, as `URL.host` gives it). The renderer cannot produce such an email
 * today; this keeps it that way when someone edits a template. `allowedLogoImg` is the one image tag the
 * renderer built for the company logo (R6Q20): it may appear once and is taken out before the image check, so
 * any other image, or a second copy of it, still throws.
 */
export function assertSafeEmail(
  email: RenderedEmail,
  allowedHosts: readonly string[],
  allowedLogoImg?: string,
): void {
  if (Object.keys(email).sort().join() !== RENDERED_KEYS) {
    throw new EmailTemplateError('an email is only subject, text and html: no attachments');
  }
  if (/[\r\n]/.test(email.subject)) {
    throw new EmailTemplateError('the email subject must be one line');
  }
  let html = email.html;
  if (allowedLogoImg !== undefined && html.split(allowedLogoImg).length === 2) {
    html = html.replace(allowedLogoImg, '');
  }
  if (HTML_FORBIDDEN.test(html)) {
    throw new EmailTemplateError('the email html must not embed images, files or scripts');
  }
  for (const part of [email.subject, email.text, email.html]) {
    if (REFERENCE_FORBIDDEN.test(part)) {
      throw new EmailTemplateError('the email must not reference attachments or scripts');
    }
    const found = [
      ...(part.match(SCHEME_URL) ?? []),
      ...[...part.matchAll(RELATIVE_URL_ATTR)].map((m) => `https:${m[1] ?? ''}`),
    ];
    for (const url of found) {
      let host: string;
      try {
        host = new URL(url).host;
      } catch {
        throw new EmailTemplateError('the email contains a link that is not a valid URL');
      }
      if (!allowedHosts.includes(host)) {
        throw new EmailTemplateError('the email contains a link to a host that is not ours');
      }
    }
  }
}

/**
 * Renders one email. `opts.workspaceUrl` is WORKSPACE_PUBLIC_URL; `opts.portalUrl` is PORTAL_PUBLIC_URL
 * and is needed only by the customer-facing templates (they throw without it). Throws EmailTemplateError
 * for a forbidden variable key, a link path outside the template's own areas, or a result that
 * assertSafeEmail refuses. `opts.logo` and `opts.companyName` (R6Q20) put the company logo, on the same host as the
 * email's link, above the heading; without a logo the email is as before.
 */
export function renderEmail(
  template: EmailTemplate,
  vars: EmailVars,
  opts: {
    workspaceUrl: string;
    portalUrl?: string | undefined;
    logo?: EmailLogo | null | undefined;
    companyName?: string | null | undefined;
  },
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
  const rule = TEMPLATE_LINKS[template];
  const given = values.linkPath;
  const path = given === undefined || given === '' ? rule.fallback : given;
  const baseUrl = rule.base === 'portal' ? opts.portalUrl : opts.workspaceUrl;
  if (baseUrl === undefined) {
    // Deny by default: a customer email is never sent with a link borrowed from another host.
    throw new EmailTemplateError(`the ${template} email needs PORTAL_PUBLIC_URL`);
  }
  const link =
    rule.base === 'portal'
      ? buildPortalLink(baseUrl, path, rule.areas)
      : buildLink(baseUrl, path, rule.areas);
  const p = parts(template, values);
  const note =
    rule.base === 'portal'
      ? 'You need to sign in to the customer portal to see the details.'
      : 'You need to sign in to Business OS to see the details.';

  const text = [p.heading, '', ...p.lines, '', `${p.linkLabel}: ${link}`, '', note].join('\n');
  const logoTag = opts.logo
    ? logoImg(buildLogoUrl(baseUrl, opts.logo), clean(opts.companyName ?? ''))
    : null;
  const html = [
    '<!doctype html>',
    '<html><body style="font-family: sans-serif; line-height: 1.5; color: #1a1a1a;">',
    ...(logoTag === null ? [] : [logoTag]),
    `<h2 style="font-size: 18px;">${escapeHtml(p.heading)}</h2>`,
    ...p.lines.map((line) => `<p>${escapeHtml(line)}</p>`),
    `<p><a href="${escapeHtml(link)}">${escapeHtml(p.linkLabel)}</a></p>`,
    `<p style="color: #666; font-size: 13px;">${escapeHtml(note)}</p>`,
    '</body></html>',
  ].join('\n');

  const rendered = { subject: p.subject, text, html };
  assertSafeEmail(rendered, [new URL(baseUrl).host], logoTag ?? undefined);
  return rendered;
}
