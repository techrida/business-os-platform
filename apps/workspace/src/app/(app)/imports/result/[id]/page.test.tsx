import type { PartyImportDetail } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));
const notFoundError = new Error('NEXT_NOT_FOUND');
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw notFoundError;
  },
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
const guard = vi.hoisted(() => ({ requireStaffSession: vi.fn() }));
vi.mock('@/lib/bff', () => guard);
const api = vi.hoisted(() => ({ getImport: vi.fn(), commitImport: vi.fn() }));
vi.mock('@/lib/api-imports', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-imports')>()),
  ...api,
}));

const { default: ResultPage } = await import('./page');
const { commitImportAction } = await import('./actions');
const ID = '11111111-1111-4111-8111-111111111111';
const base: PartyImportDetail = {
  id: ID,
  kind: 'customer',
  status: 'previewed',
  fileName: 'people.csv',
  rowCount: 4,
  validCount: 1,
  createdCount: 0,
  duplicateCount: 1,
  errorCount: 2,
  createdByUserId: '22222222-2222-4222-8222-222222222222',
  createdAt: '2026-11-21T04:00:00.000Z',
  committedAt: null,
  rows: [
    { line: 2, name: 'Good Co', pan: '123456789', status: 'valid', issues: [] },
    {
      line: 3,
      name: '',
      pan: null,
      status: 'error',
      issues: [{ column: 'legal_name', message: 'legal name is required' }],
    },
    {
      line: 4,
      name: 'Bad Mail',
      pan: null,
      status: 'error',
      issues: [{ column: 'contact_email', message: 'contact email is not a valid email address' }],
    },
    {
      line: 5,
      name: 'Twin',
      pan: '987654321',
      status: 'duplicate',
      issues: [{ column: null, message: 'Already exists in this company, so it is skipped' }],
    },
  ],
};
const render = async (searchParams: { error?: string } = {}, id = ID) =>
  renderToStaticMarkup(
    await ResultPage({
      params: Promise.resolve({ id }),
      searchParams: Promise.resolve(searchParams),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  guard.requireStaffSession.mockResolvedValue({ accessToken: 't' });
  api.getImport.mockResolvedValue(base);
});

it('shows the preview with every row, its problems, the counts and one import button', async () => {
  const html = await render();
  expect(guard.requireStaffSession).toHaveBeenCalledWith(`/imports/result/${ID}`);
  expect(html).toContain('Nothing has been created yet');
  expect(html).toContain('Import 1 customer');
  expect(html).toContain('legal name: legal name is required');
  expect(html).toContain('contact email: contact email is not a valid email address');
  expect(html).toContain('Already exists in this company');
  expect(html).toContain('(no name)');
  expect(html).toContain(`/imports/result/${ID}/errors`);
  expect(html.match(/<form/g)).toHaveLength(1);
});

it('after the commit shows the created count and no import button, and keeps the error report', async () => {
  api.getImport.mockResolvedValue({
    ...base,
    status: 'committed',
    validCount: 0,
    createdCount: 1,
    committedAt: '2026-11-21T05:00:00.000Z',
    rows: base.rows.map((r) => (r.status === 'valid' ? { ...r, status: 'created' as const } : r)),
  });
  const html = await render();
  expect(html).toContain('Imported people.csv');
  expect(html).toContain('Customers created');
  expect(html).not.toContain('<form');
  expect(html).toContain('Download the error report');
  expect(html).toContain('Back to customers');
});

it('says so when no row is ready, and offers no import', async () => {
  api.getImport.mockResolvedValue({ ...base, validCount: 0, rows: base.rows.slice(1) });
  const html = await render();
  expect(html).toContain('No row is ready to import');
  expect(html).not.toContain('<form');
});

it('shows a refusal the commit left in the URL, and a 404 from the API is a not-found page', async () => {
  expect(await render({ error: 'Something went wrong' })).toContain('Something went wrong');
  api.getImport.mockRejectedValue(new ApiError(404, 'nope'));
  await expect(render()).rejects.toBe(notFoundError);
  await expect(render({}, 'not-an-id')).rejects.toBe(notFoundError);
  api.getImport.mockRejectedValue(new ApiError(403, 'no'));
  expect(await render()).toContain('The import did not load');
});

it('commits through the API for a valid id and lands on the result page, or back with the reason', async () => {
  api.commitImport.mockResolvedValue(base);
  const form = new FormData();
  form.set('id', ID.toUpperCase());
  await expect(commitImportAction(form)).rejects.toThrow(`REDIRECT:/imports/result/${ID}`);
  expect(api.commitImport).toHaveBeenCalledExactlyOnceWith({ accessToken: 't' }, ID);
  api.commitImport.mockRejectedValue(new ApiError(403, 'no'));
  await expect(commitImportAction(form)).rejects.toThrow(/REDIRECT:\/imports\/result\/.*\?error=/);
  const bad = new FormData();
  bad.set('id', 'x');
  api.commitImport.mockClear();
  await expect(commitImportAction(bad)).rejects.toThrow('REDIRECT:/customers');
  expect(api.commitImport).not.toHaveBeenCalled();
});
