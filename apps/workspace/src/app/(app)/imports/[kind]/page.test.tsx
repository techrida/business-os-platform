import type { PartyImportBatch } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
const notFoundError = new Error('NEXT_NOT_FOUND');
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw notFoundError;
  },
}));
const session = vi.hoisted(() => ({ roles: ['sales'] as string[] }));
const guard = vi.hoisted(() => ({ requireStaffSession: vi.fn() }));
vi.mock('@/lib/bff', () => guard);
const api = vi.hoisted(() => ({ listImports: vi.fn() }));
vi.mock('@/lib/api-imports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-imports')>()),
  ...api,
}));
vi.mock('@/lib/grants', async () => {
  const { DEFAULT_ROLE_PERMISSIONS } = await import('@bos/contracts');
  return {
    getGrants: (s: { roles: string[] }) =>
      Promise.resolve(
        new Map(
          s.roles.flatMap((r) =>
            Object.entries(DEFAULT_ROLE_PERMISSIONS[r as keyof typeof DEFAULT_ROLE_PERMISSIONS]),
          ),
        ),
      ),
    hasGrant: (g: Map<string, string>, p: string) => g.has(p),
  };
});

const { default: ImportPage } = await import('./page');
const batch: PartyImportBatch = {
  id: '11111111-1111-4111-8111-111111111111',
  kind: 'customer',
  status: 'committed',
  fileName: 'people.csv',
  rowCount: 10,
  validCount: 0,
  createdCount: 7,
  duplicateCount: 1,
  errorCount: 2,
  createdByUserId: '22222222-2222-4222-8222-222222222222',
  createdAt: '2026-11-21T04:00:00.000Z',
  committedAt: '2026-11-21T04:05:00.000Z',
};
const render = async (kind = 'customers', searchParams: { error?: string } = {}) =>
  renderToStaticMarkup(
    await ImportPage({
      params: Promise.resolve({ kind }),
      searchParams: Promise.resolve(searchParams),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  session.roles = ['sales'];
  guard.requireStaffSession.mockResolvedValue(session);
  api.listImports.mockResolvedValue([batch]);
});

it('shows the template link, the upload form and the recent imports for a role that may create customers', async () => {
  const html = await render();
  expect(guard.requireStaffSession).toHaveBeenCalledWith('/imports/customers');
  expect(html).toContain('/imports/customers/template');
  expect(html).toContain('action="/imports/customers/upload"');
  expect(html.toLowerCase()).toContain('enctype="multipart/form-data"');
  expect(html).toContain('type="file"');
  expect(html).toContain('legal_name, address_line1, address_city, contact_email');
  expect(html).toContain('people.csv');
  expect(html).toContain(`/imports/result/${batch.id}`);
  expect(api.listImports).toHaveBeenCalledWith(session, 'customer');
});

it('refuses a role without the grant of that kind before listing anything, and an unknown kind is a 404', async () => {
  expect(await render('vendors')).toContain('Your roles do not include importing vendors');
  expect(api.listImports).not.toHaveBeenCalled();
  await expect(render('suppliers')).rejects.toBe(notFoundError);
});

it('shows why the last upload was refused, and a failed history load without hiding the form', async () => {
  api.listImports.mockRejectedValue(new ApiError(502, 'down'));
  const html = await render('customers', { error: 'The column "x" is missing' });
  expect(html).toContain('The file was not accepted');
  expect(html).toContain('The column &quot;x&quot; is missing');
  expect(html).toContain('type="file"');
});
