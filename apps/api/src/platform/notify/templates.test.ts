import { describe, expect, it } from 'vitest';

import {
  EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_VARS,
  EmailTemplateError,
  buildLink,
  renderEmail,
  type EmailTemplate,
} from './templates';

const opts = { workspaceUrl: 'https://app.example.com' };

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
  linkPath: '/inbox/6f1c2a9e-1b7d-4c55-9a53-0d6f3e2b7a10',
};

describe('renderEmail', () => {
  it.each(EMAIL_TEMPLATES)('%s renders with no token, password or file link', (template) => {
    const { subject, text, html } = renderEmail(template, sample, opts);
    for (const part of [subject, text, html]) {
      expect(part).not.toMatch(/token/i);
      expect(part).not.toMatch(/password/i);
      expect(part).not.toContain('/files/');
    }
    expect(subject.length).toBeGreaterThan(0);
    // The one link is the workspace inbox link, in both the text and the html part.
    expect(text).toContain(`${opts.workspaceUrl}${sample.linkPath}`);
    expect(html).toContain(`href="${opts.workspaceUrl}${sample.linkPath}"`);
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
  });

  it('HTML-escapes every variable', () => {
    const evil = '<script>alert("x")</script>';
    for (const template of EMAIL_TEMPLATES) {
      const vars = Object.fromEntries(
        EMAIL_TEMPLATE_VARS[template].map((k) => [k, k === 'linkPath' ? sample.linkPath! : evil]),
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
  });

  it('cuts very long values', () => {
    const { text } = renderEmail(
      'approval.pending',
      { ...sample, requesterName: 'a'.repeat(5000) },
      opts,
    );
    expect(text).not.toContain('a'.repeat(300));
  });

  it('falls back to neutral defaults for missing or empty variables', () => {
    for (const template of EMAIL_TEMPLATES as readonly EmailTemplate[]) {
      const { subject, text, html } = renderEmail(template, { documentNumber: '' }, opts);
      for (const part of [subject, text, html]) {
        expect(part).not.toMatch(/undefined|null|\{\{/);
      }
      expect(text).toContain(`${opts.workspaceUrl}/inbox/`);
    }
  });

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
  ])('throws for the link path %s', (linkPath) => {
    expect(() => renderEmail('approval.pending', { ...sample, linkPath }, opts)).toThrow(
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
  ])('throws for the forbidden variable key %s', (key) => {
    expect(() => renderEmail('approval.pending', { ...sample, [key]: 'x' }, opts)).toThrow(
      EmailTemplateError,
    );
  });

  it('throws for an unknown template and a non-http workspace URL', () => {
    expect(() => renderEmail('nope' as EmailTemplate, sample, opts)).toThrow(EmailTemplateError);
    expect(() =>
      renderEmail('approval.pending', sample, { workspaceUrl: 'javascript:alert(1)' }),
    ).toThrow(EmailTemplateError);
  });
});

describe('buildLink', () => {
  it('joins the workspace URL and an allowed path', () => {
    expect(buildLink('https://app.example.com', '/inbox/abc')).toBe(
      'https://app.example.com/inbox/abc',
    );
  });
});
