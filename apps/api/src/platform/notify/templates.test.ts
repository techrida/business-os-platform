import { describe, expect, it } from 'vitest';

import {
  EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_VARS,
  EmailTemplateError,
  assertSafeEmail,
  buildLink,
  buildLogoUrl,
  buildPortalLink,
  renderEmail,
  type EmailTemplate,
  type RenderedEmail,
} from './templates';

const WORKSPACE = 'https://app.example.com';
const PORTAL = 'https://portal.example.com';
const opts = { workspaceUrl: WORKSPACE, portalUrl: PORTAL };

/** Which base each template links to, and the path it uses in these tests. Written out on purpose: the test must not read the answer from the code under test. */
const STAFF_TEMPLATES = [
  'approval.pending',
  'approval.reminder',
  'approval.escalated',
  'approval.decided',
  'approval.blocked',
  'document.infected',
  'outbox.dead_letter',
] as const;
const NEW_STAFF_TEMPLATES = ['quotation.accepted', 'crm.assigned', 'crm.follow_up_digest'] as const;
const PORTAL_TEMPLATES = [
  'quotation.sent',
  'quotation.expiring',
  'quotation.expired',
  'portal.invite',
] as const;

const LINK_PATH_OF: Record<EmailTemplate, string> = {
  'approval.pending': '/inbox/6f1c2a9e-1b7d-4c55-9a53-0d6f3e2b7a10',
  'approval.reminder': '/inbox/6f1c2a9e-1b7d-4c55-9a53-0d6f3e2b7a10',
  'approval.escalated': '/inbox/6f1c2a9e-1b7d-4c55-9a53-0d6f3e2b7a10',
  'approval.decided': '/inbox/6f1c2a9e-1b7d-4c55-9a53-0d6f3e2b7a10',
  'approval.blocked': '/inbox/6f1c2a9e-1b7d-4c55-9a53-0d6f3e2b7a10',
  'document.infected': '/inbox/6f1c2a9e-1b7d-4c55-9a53-0d6f3e2b7a10',
  'outbox.dead_letter': '/inbox/6f1c2a9e-1b7d-4c55-9a53-0d6f3e2b7a10',
  'quotation.accepted': '/quotations/0b9c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4',
  'crm.assigned': '/leads/0b9c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4',
  'crm.follow_up_digest': '/activities/',
  'quotation.sent': '/quotations/0b9c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4',
  'quotation.expiring': '/quotations/0b9c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4',
  'quotation.expired': '/quotations/0b9c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4',
  'portal.invite': '/sign-in/',
};

const baseOf = (template: EmailTemplate): string =>
  (PORTAL_TEMPLATES as readonly string[]).includes(template) ? PORTAL : WORKSPACE;

const sample: Record<string, string> = {
  documentNumber: 'MEMO-2082/83-00042',
  documentType: 'memo',
  requesterName: 'Sita Sharma',
  escalatedFromName: 'Ram Thapa',
  deciderName: 'Gita Rai',
  decision: 'approved',
  reason: 'the approver has no active account',
  filename: 'invoice.pdf',
  failedTemplate: 'approval.pending',
  attempts: '5',
  quotationNumber: 'QT-2082/83-00007',
  customerName: 'Himal Traders',
  validUntil: '2026-11-19',
  entityType: 'lead',
  entityName: 'Himal Traders',
  assignerName: 'Hari Gurung',
  dueCount: '4',
  overdueCount: '2',
  linkPath: '/inbox/6f1c2a9e-1b7d-4c55-9a53-0d6f3e2b7a10',
};

/** The sample with the link path that is valid for this template. */
const varsFor = (template: EmailTemplate): Record<string, string> => ({
  ...sample,
  linkPath: LINK_PATH_OF[template],
});

describe('renderEmail', () => {
  it('knows every template these tests list, and no other', () => {
    expect([...EMAIL_TEMPLATES].sort()).toEqual(
      [...STAFF_TEMPLATES, ...NEW_STAFF_TEMPLATES, ...PORTAL_TEMPLATES].sort(),
    );
  });

  it.each(EMAIL_TEMPLATES)('%s renders with no token, password or file link', (template) => {
    const { subject, text, html } = renderEmail(template, varsFor(template), opts);
    for (const part of [subject, text, html]) {
      expect(part).not.toMatch(/token/i);
      expect(part).not.toMatch(/password/i);
      expect(part).not.toContain('/files/');
    }
    expect(subject.length).toBeGreaterThan(0);
    // The one link is built from the template's own base, in both the text and the html part.
    const link = `${baseOf(template)}${LINK_PATH_OF[template]}`;
    expect(text).toContain(link);
    expect(html).toContain(`href="${link}"`);
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it('lists the allowed variables of every template, each with linkPath', () => {
    for (const template of EMAIL_TEMPLATES) {
      expect(EMAIL_TEMPLATE_VARS[template]).toContain('linkPath');
    }
    expect(Object.keys(EMAIL_TEMPLATE_VARS).sort()).toEqual([...EMAIL_TEMPLATES].sort());
  });

  it('puts the values into the subject and the body', () => {
    const { subject, text } = renderEmail('approval.pending', sample, opts);
    expect(subject).toContain('MEMO-2082/83-00042');
    expect(text).toContain('Sita Sharma');

    const sent = renderEmail('quotation.sent', varsFor('quotation.sent'), opts);
    expect(sent.subject).toContain('QT-2082/83-00007');
    expect(sent.text).toContain('Himal Traders');
    expect(sent.text).toContain('19 Nov 2026');

    const digest = renderEmail('crm.follow_up_digest', varsFor('crm.follow_up_digest'), opts);
    expect(digest.text).toContain('4');
    expect(digest.text).toContain('2');
  });

  it('HTML-escapes every variable', () => {
    const evil = '<script>alert("x")</script>';
    for (const template of EMAIL_TEMPLATES) {
      const vars = Object.fromEntries(
        EMAIL_TEMPLATE_VARS[template].map((k) => [
          k,
          k === 'linkPath' ? LINK_PATH_OF[template] : evil,
        ]),
      );
      const { html } = renderEmail(template, vars, opts);
      expect(html).not.toContain('<script>');
      if (EMAIL_TEMPLATE_VARS[template].length > 1) expect(html).toContain('&lt;script&gt;');
    }
  });

  it('removes line breaks from values so a subject cannot gain a header', () => {
    const { subject } = renderEmail(
      'approval.pending',
      { ...sample, documentNumber: 'X\r\nBcc: attacker@example.com' },
      opts,
    );
    expect(subject).not.toMatch(/[\r\n]/);
    const sent = renderEmail(
      'quotation.sent',
      { ...varsFor('quotation.sent'), quotationNumber: 'X\r\nBcc: attacker@example.com' },
      opts,
    );
    expect(sent.subject).not.toMatch(/[\r\n]/);
  });

  it('cuts very long values', () => {
    const { text } = renderEmail(
      'approval.pending',
      { ...sample, requesterName: 'a'.repeat(5000) },
      opts,
    );
    expect(text).not.toContain('a'.repeat(300));
  });

  // The path a template falls back to when the caller gives none, stated per template.
  const DEFAULT_LINKS: [EmailTemplate, string][] = [
    ...STAFF_TEMPLATES.map((t): [EmailTemplate, string] => [t, `${WORKSPACE}/inbox/`]),
    ['quotation.accepted', `${WORKSPACE}/quotations/`],
    ['crm.assigned', `${WORKSPACE}/activities/`],
    ['crm.follow_up_digest', `${WORKSPACE}/activities/`],
    ['quotation.sent', `${PORTAL}/quotations/`],
    ['quotation.expiring', `${PORTAL}/quotations/`],
    ['quotation.expired', `${PORTAL}/quotations/`],
    ['portal.invite', `${PORTAL}/sign-in/`],
  ];

  it.each(DEFAULT_LINKS)(
    '%s falls back to neutral defaults for missing or empty variables, linking to %s',
    (template, expectedLink) => {
      const { subject, text, html } = renderEmail(template, { documentNumber: '' }, opts);
      for (const part of [subject, text, html]) {
        expect(part).not.toMatch(/undefined|null|\{\{/);
      }
      expect(text).toContain(expectedLink);
    },
  );

  it('ignores variables the template does not list', () => {
    const { subject, text, html } = renderEmail(
      'document.infected',
      { ...sample, reason: 'LEAKY-REASON' },
      opts,
    );
    expect(`${subject}${text}${html}`).not.toContain('LEAKY-REASON');
  });

  it('accepts a /memos/ link and trims a trailing slash from the workspace URL', () => {
    const { text } = renderEmail(
      'approval.decided',
      { ...sample, linkPath: '/memos/abc-123' },
      { workspaceUrl: 'https://app.example.com/' },
    );
    expect(text).toContain('https://app.example.com/memos/abc-123');
  });

  it('accepts a /quotations/ link on the decided email only (a quotation subject links its page)', () => {
    const { text } = renderEmail(
      'approval.decided',
      { ...sample, linkPath: '/quotations/abc-123' },
      opts,
    );
    expect(text).toContain(`${WORKSPACE}/quotations/abc-123`);
    for (const template of [
      'approval.pending',
      'approval.reminder',
      'approval.escalated',
      'approval.blocked',
    ] as const) {
      expect(() =>
        renderEmail(template, { ...varsFor(template), linkPath: '/quotations/abc-123' }, opts),
      ).toThrow(EmailTemplateError);
    }
  });

  it.each([
    'https://evil.example.com/inbox/1',
    '//evil.example.com/inbox/1',
    '/files/abc',
    '/inbox',
    '/inbox/../files/abc',
    '/inbox/1?next=https://evil.example.com',
    '/inbox/1#frag',
    '/inbox/1 2',
    '/memos/..%2f',
    'inbox/1',
    '/admin/users',
    // Real areas, but not this template's: each template has its own list.
    '/quotations/1',
    '/crm/1',
    '/sign-in/',
  ])('throws for the link path %s on an approval email', (linkPath) => {
    expect(() => renderEmail('approval.pending', { ...sample, linkPath }, opts)).toThrow(
      EmailTemplateError,
    );
  });

  it.each([
    ['crm.assigned', '/inbox/1'],
    // The workspace has no /crm page, so a link there would be a dead end.
    ['crm.assigned', '/crm/1'],
    ['crm.assigned', '/leads'],
    ['crm.follow_up_digest', '/memos/1'],
    ['crm.follow_up_digest', '/leads/1'],
    ['quotation.accepted', '/crm/1'],
    ['quotation.accepted', '/leads/1'],
    ['quotation.sent', '/inbox/1'],
    ['quotation.sent', '/crm/1'],
    ['quotation.sent', '/quotations/1?x=1'],
    ['quotation.sent', '/quotations/../admin'],
    ['quotation.sent', 'https://evil.example.com/quotations/1'],
    ['quotation.sent', '//evil.example.com/quotations/1'],
    ['quotation.expired', '/files/abc'],
    ['portal.invite', '/quotations/1'],
    ['portal.invite', '/sign-in/?token=abc'],
    ['portal.invite', 'https://evil.example.com/sign-in/'],
  ] as const)('throws for %s with the link path %s', (template, linkPath) => {
    expect(() => renderEmail(template, { ...varsFor(template), linkPath }, opts)).toThrow(
      EmailTemplateError,
    );
  });

  it.each([
    'token',
    'accessToken',
    'secret',
    'password',
    'Password',
    'signature',
    'scanSignature',
    'api_secret_key',
    'inviteToken',
  ])('throws for the forbidden variable key %s', (key) => {
    expect(() => renderEmail('approval.pending', { ...sample, [key]: 'x' }, opts)).toThrow(
      EmailTemplateError,
    );
    expect(() =>
      renderEmail('portal.invite', { ...varsFor('portal.invite'), [key]: 'x' }, opts),
    ).toThrow(EmailTemplateError);
  });

  it('throws for an unknown template and a non-http workspace URL', () => {
    expect(() => renderEmail('nope' as EmailTemplate, sample, opts)).toThrow(EmailTemplateError);
    expect(() =>
      renderEmail('approval.pending', sample, { workspaceUrl: 'javascript:alert(1)' }),
    ).toThrow(EmailTemplateError);
  });
});

it.each([
  ['/leads/0b9c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4'],
  ['/opportunities/0b9c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4'],
  ['/quotations/0b9c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4'],
  ['/activities/'],
])('crm.assigned links to the record it hands over (%s), a page the workspace has', (linkPath) => {
  const { text, html } = renderEmail(
    'crm.assigned',
    { entityType: 'lead', entityName: 'LD-2083/84-00001', assignerName: 'Sita', linkPath },
    opts,
  );
  expect(text).toContain(`${WORKSPACE}${linkPath}`);
  expect(html).toContain(`${WORKSPACE}${linkPath}`);
});

describe('portal links', () => {
  it.each(PORTAL_TEMPLATES)(
    '%s links to the portal host and never the workspace host',
    (template) => {
      const { text, html } = renderEmail(template, varsFor(template), opts);
      expect(text).toContain(PORTAL);
      expect(html).toContain(PORTAL);
      expect(`${text}${html}`).not.toContain('app.example.com');
    },
  );

  it.each(['quotation.accepted', 'crm.assigned', 'crm.follow_up_digest'] as const)(
    '%s (a staff email) links to the workspace host and never the portal host',
    (template) => {
      const { text, html } = renderEmail(template, varsFor(template), opts);
      expect(`${text}${html}`).not.toContain('portal.example.com');
      expect(text).toContain(WORKSPACE);
    },
  );

  it.each(PORTAL_TEMPLATES)('%s refuses to render when no portal URL is configured', (template) => {
    expect(() => renderEmail(template, varsFor(template), { workspaceUrl: WORKSPACE })).toThrow(
      EmailTemplateError,
    );
    expect(() =>
      renderEmail(template, varsFor(template), { workspaceUrl: WORKSPACE, portalUrl: 'ftp://x' }),
    ).toThrow(EmailTemplateError);
  });

  it('a portal invite carries a sign-in link and no invite token', () => {
    const { subject, text, html } = renderEmail('portal.invite', varsFor('portal.invite'), opts);
    expect(text).toContain(`${PORTAL}/sign-in/`);
    for (const part of [subject, text, html]) {
      expect(part).not.toMatch(/token|code=|invite=|\?/i);
    }
  });
});

describe('buildLink and buildPortalLink', () => {
  it('join the base URL and an allowed path', () => {
    expect(buildLink('https://app.example.com', '/inbox/abc')).toBe(
      'https://app.example.com/inbox/abc',
    );
    expect(buildPortalLink('https://portal.example.com/', '/quotations/abc')).toBe(
      'https://portal.example.com/quotations/abc',
    );
  });

  it('keep each base to its own areas', () => {
    expect(() => buildLink('https://app.example.com', '/sign-in/')).toThrow(EmailTemplateError);
    expect(() => buildPortalLink('https://portal.example.com', '/inbox/abc')).toThrow(
      EmailTemplateError,
    );
    expect(() => buildPortalLink('', '/quotations/abc')).toThrow(EmailTemplateError);
  });
});

describe('no attachment and no foreign host (ADR 0023: email a portal link, never a file)', () => {
  const hostile: Record<string, string> = Object.fromEntries(
    [
      'documentNumber',
      'documentType',
      'requesterName',
      'escalatedFromName',
      'deciderName',
      'decision',
      'reason',
      'filename',
      'failedTemplate',
      'attempts',
      'quotationNumber',
      'customerName',
      'validUntil',
      'entityType',
      'entityName',
      'assignerName',
      'dueCount',
      'overdueCount',
    ].map((key) => [
      key,
      'Pay at https://evil.example/pay or www.evil.example or javascript:alert(1) or data:text/html;base64,AAAA or cid:logo',
    ]),
  );

  const allowed = [new URL(WORKSPACE).host, new URL(PORTAL).host];

  function urlsIn(part: string): string[] {
    // Links with a scheme, plus protocol-relative ones in an attribute (href="//host"). A bare a//b is not a link.
    const relative = [...part.matchAll(/\b(?:href|src|action)\s*=\s*["']?(\/\/[^\s"'<>]+)/gi)].map(
      (m) => m[1] ?? '',
    );
    return [...(part.match(/\bhttps?:\/\/[^\s"'<>)]+/gi) ?? []), ...relative];
  }

  it.each(EMAIL_TEMPLATES)(
    '%s has exactly subject, text and html, and only our own hosts',
    (template) => {
      const rendered = renderEmail(
        template,
        { ...hostile, linkPath: LINK_PATH_OF[template] },
        opts,
      );
      expect(Object.keys(rendered).sort()).toEqual(['html', 'subject', 'text']);
      for (const part of [rendered.subject, rendered.text, rendered.html]) {
        for (const url of urlsIn(part)) {
          const full = url.startsWith('//') ? `https:${url}` : url;
          expect(allowed).toContain(new URL(full).host);
        }
        expect(part).not.toMatch(/evil\.example/i);
        expect(part).not.toMatch(/\bcid:|data:text|javascript:/i);
      }
      expect(rendered.html).not.toMatch(/<(?:img|iframe|object|embed|link|form|script)\b/i);
      expect(rendered.html).not.toMatch(/\bsrc\s*=/i);
    },
  );

  // Harmless text a caller may pass through (a reason, a filename). It must never make a render throw,
  // because the render runs inside the caller's transaction and a throw would roll the business change back.
  it.each([
    'javascript: off',
    'cid: 12',
    'data : sheet',
    'src=main',
    'href=//x.com',
    'action = "//x.com"',
    'a//b',
    'see www.x',
    'Report: data: Q3, src= and cid:',
  ])('%s as a value does not make any template throw or add a foreign host', (value) => {
    for (const template of EMAIL_TEMPLATES) {
      const vars = Object.fromEntries(
        EMAIL_TEMPLATE_VARS[template].map((k) => [
          k,
          k === 'linkPath' ? LINK_PATH_OF[template] : value,
        ]),
      );
      const rendered = renderEmail(template, vars, opts);
      const base = new URL(baseOf(template)).host;
      for (const part of [rendered.subject, rendered.text, rendered.html]) {
        for (const url of urlsIn(part)) {
          const full = url.startsWith('//') ? `https:${url}` : url;
          expect(new URL(full).host).toBe(base);
        }
      }
    }
  });

  const good: RenderedEmail = {
    subject: 'Quotation ready',
    text: `Open: ${PORTAL}/quotations/1`,
    html: `<p><a href="${PORTAL}/quotations/1">Open</a></p>`,
  };

  it('assertSafeEmail accepts a clean email', () => {
    expect(() => assertSafeEmail(good, allowed)).not.toThrow();
  });

  it.each([
    ['a foreign link in the text', { ...good, text: 'Open https://evil.example/x' }],
    ['a foreign href in the html', { ...good, html: '<a href="https://evil.example/x">x</a>' }],
    ['a protocol-relative foreign link', { ...good, html: '<a href="//evil.example/x">x</a>' }],
    ['a look-alike host', { ...good, text: `Open ${PORTAL}.evil.example/x` }],
    ['an embedded image', { ...good, html: `${good.html}<img src="${PORTAL}/logo.png">` }],
    ['a cid: attachment reference', { ...good, html: `${good.html}<p>cid:logo</p>` }],
    [
      'a data: payload',
      { ...good, html: `${good.html}<a href="data:text/html;base64,AAAA">x</a>` },
    ],
    ['a javascript: link', { ...good, html: '<a href="javascript:alert(1)">x</a>' }],
    ['an attachments key', { ...good, attachments: [{ filename: 'quote.pdf' }] }],
    ['an extra key', { ...good, headers: { Bcc: 'x@example.com' } }],
    ['a line break in the subject', { ...good, subject: 'a\r\nBcc: x@example.com' }],
  ])('assertSafeEmail rejects %s', (_name, email) => {
    expect(() => assertSafeEmail(email, allowed)).toThrow(EmailTemplateError);
  });
});

describe('the company logo (R6Q20)', () => {
  const TENANT = '0b9c1d2e-3f4a-4b5c-8d6e-7f8091a2b3c4';
  const logo = { tenantId: TENANT };

  it('is absent without a logo, so every email is as before', () => {
    for (const template of EMAIL_TEMPLATES) {
      const vars = { linkPath: LINK_PATH_OF[template] };
      expect(renderEmail(template, vars, opts).html).not.toContain('<img');
      expect(renderEmail(template, vars, { ...opts, logo: null }).html).not.toContain('<img');
    }
  });

  it.each([
    ['approval.pending', WORKSPACE],
    ['quotation.sent', PORTAL],
  ] as const)('%s shows one logo image on the host of its own link', (template, base) => {
    const html = renderEmail(
      template,
      { linkPath: LINK_PATH_OF[template] },
      { ...opts, logo, companyName: 'Techrida <b>' },
    ).html;
    const url = `${base}/brand/logo/${TENANT}`;
    expect(html.match(/<img\b/g)).toHaveLength(1);
    expect(html).toContain(`<img src="${url}" alt="Techrida &lt;b&gt;"`);
    expect(buildLogoUrl(base, logo)).toBe(url);
  });

  it('every other image is still refused, and so is a second copy of the logo or one on a foreign host', () => {
    const rendered = renderEmail(
      'quotation.sent',
      { linkPath: LINK_PATH_OF['quotation.sent'] },
      { ...opts, logo },
    );
    const tag = /<img[^>]*>/.exec(rendered.html)?.[0] ?? '';
    const hosts = [new URL(PORTAL).host];
    expect(() => assertSafeEmail(rendered, hosts, tag)).not.toThrow();
    // Without being told about the tag, the same email is refused.
    expect(() => assertSafeEmail(rendered, hosts)).toThrow(EmailTemplateError);
    for (const extra of [
      tag,
      `<img src="${PORTAL}/brand/logo/other.png">`,
      '<img src="https://evil.example/x.png">',
    ]) {
      expect(() =>
        assertSafeEmail({ ...rendered, html: rendered.html + extra }, hosts, tag),
      ).toThrow(EmailTemplateError);
    }
  });

  it('builds the address only from an http(s) base and one guid', () => {
    expect(() => buildLogoUrl('javascript:alert(1)', logo)).toThrow(EmailTemplateError);
    expect(() => buildLogoUrl(PORTAL, { tenantId: '../x' })).toThrow(EmailTemplateError);
  });
});
