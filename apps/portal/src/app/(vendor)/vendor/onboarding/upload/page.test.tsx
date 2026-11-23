import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sampleOnboarding } from '@/components/vendor/vendor-fixtures';
import { ApiError } from '@/lib/api';

import { Redirect, vendorSession } from '../../_upload/test-kit';

const m = vi.hoisted(() => ({ getSession: vi.fn(), getVendorOnboarding: vi.fn() }));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/session', () => ({ getSession: m.getSession }));
vi.mock('@/lib/api.vendor', () => ({ getVendorOnboarding: m.getVendorOnboarding }));

const { default: UploadKycPage } = await import('./page');

const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = async (search: { doc?: string; sent?: string } = {}) =>
  renderToStaticMarkup(
    (await UploadKycPage({ searchParams: Promise.resolve(search) })) as ReactElement,
  );

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  m.getSession.mockResolvedValue(vendorSession());
  m.getVendorOnboarding.mockResolvedValue(sampleOnboarding());
});

describe('send a KYC document page', () => {
  it('offers only the vendor’s own checklist, with where each stands, and one key', async () => {
    const html = await render();
    expect(html).toContain('Send a document');
    expect(html).toContain('PAN certificate (accepted)');
    expect(html).toContain('Bank proof (not uploaded)');
    expect(html).not.toContain('Foreign registration');
    expect(html).toMatch(/name="idempotencyKey" value="[0-9a-f-]{36}"/);
  });

  it('says the details changed and that a file sent before cannot be used', async () => {
    m.getVendorOnboarding.mockResolvedValue(
      sampleOnboarding({ detailsChanged: { at: '2026-11-23T04:00:00.000Z', by: null } }),
    );
    const t = text(await render());
    expect(t).toMatch(/Details changed on .*; upload the documents again\./);
    expect(t).toContain('A file you sent before the change cannot be used.');
    m.getVendorOnboarding.mockResolvedValue(sampleOnboarding());
    expect(text(await render())).not.toContain('Details changed');
  });

  it('starts on a document that still needs sending, or on the one asked for', async () => {
    // The first checklist item that is missing, rejected or expired: tax clearance (rejected).
    const chosen = (docType: string) => `<input type="hidden" name="docType" value="${docType}"/>`;
    expect(await render()).toContain(chosen('tax_clearance'));
    expect(await render({ doc: 'bank_proof' })).toContain(chosen('bank_proof'));
    // An unknown or unlisted ?doc= falls back to the default.
    expect(await render({ doc: 'foreign_registration' })).toContain(chosen('tax_clearance'));
  });

  it('asks for the expiry date on a tax clearance only', async () => {
    expect(await render({ doc: 'tax_clearance' })).toContain('name="validUntil"');
    expect(await render({ doc: 'bank_proof' })).not.toContain('name="validUntil"');
  });

  // KYC is for an account that can onboard: set up, being checked, approved or suspended.
  it.each(['onboarding_only', 'full', 'read_only'] as const)(
    'opens for a %s account',
    async (capability) => {
      m.getVendorOnboarding.mockResolvedValue(sampleOnboarding({ capability }));
      expect(text(await render())).toContain('Send a document');
    },
  );

  it('shows the no-access notice for a closed account and for a 403', async () => {
    m.getVendorOnboarding.mockResolvedValue(sampleOnboarding({ capability: 'none' }));
    expect(text(await render())).toContain('cannot use this page');
    m.getVendorOnboarding.mockRejectedValue(new ApiError(403, 'no'));
    expect(text(await render())).toContain('cannot use this page');
  });

  it('says so when nothing is on the checklist yet, and confirms a sent document', async () => {
    m.getVendorOnboarding.mockResolvedValue(sampleOnboarding({ documents: [] }));
    const html = text(await render({ sent: '1' }));
    expect(html).toContain('No documents are required yet');
    expect(html).toContain('We received your document');
    expect(html).not.toContain('Send document');
  });

  it('sends a visitor without a session to sign in and back', async () => {
    m.getSession.mockResolvedValue(null);
    await expect(render()).rejects.toThrow(
      'redirect /auth/login?returnTo=%2Fvendor%2Fonboarding%2Fupload',
    );
  });
});
