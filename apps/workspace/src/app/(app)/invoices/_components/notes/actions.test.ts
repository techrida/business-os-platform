import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { InvoiceFormState } from '../../new/form-state';
import { ID, KEY, TAX, invoiceDetail } from '../../_lib/test-fixtures';

import { createCreditNoteAction, createDebitNoteAction } from './actions';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  apiFetch: vi.fn(),
  getMe: vi.fn(),
  redirect: vi.fn(),
  revalidatePath: vi.fn(),
}));
vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
  getMe: mocks.getMe,
}));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));

const prev: InvoiceFormState = { key: KEY, errors: {} };
const NOTE_ID = '99999999-9999-4999-8999-999999999999';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function form(over: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries({ originalInvoiceId: ID, idempotencyKey: KEY, ...over })) {
    f.append(k, v);
  }
  return f;
}

const credit = (over: Record<string, string> = {}) =>
  form({
    reason: 'Goods came back damaged.',
    lines: JSON.stringify([
      { lineNo: 1, quantity: '' },
      { lineNo: 2, quantity: '1.5' },
    ]),
    ...over,
  });

const debit = (over: Record<string, string> = {}) =>
  form({
    reason: 'Late payment fee.',
    lines: JSON.stringify([
      {
        key: 'l1',
        description: 'Late fee',
        uom: 'lot',
        quantity: '1',
        unitPrice: '500',
        taxCodeId: TAX,
      },
    ]),
    ...over,
  });

const IN_PROGRESS = {
  error: {
    code: 'conflict',
    message: 'A request with this Idempotency-Key is still being processed.',
  },
};

function answer(status: number, body: unknown = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

const call = () => mocks.apiFetch.mock.calls[0] as [unknown, string, RequestInit];

beforeEach(() => {
  vi.clearAllMocks();
  // Until a test sets live grants, GET /v1/me fails and the role defaults decide.
  mocks.getMe.mockRejectedValue(new Error('upstream down'));
  mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['finance'] });
  mocks.apiFetch.mockImplementation(() =>
    answer(
      201,
      invoiceDetail({ id: NOTE_ID, kind: 'credit_note', originalInvoiceId: ID, noteReason: 'x' }),
    ),
  );
  mocks.redirect.mockImplementation((to: string) => {
    throw new Error(`REDIRECT ${to}`);
  });
});

describe('createCreditNoteAction', () => {
  it('posts the lines to credit by original line number and opens the note the server priced', async () => {
    await expect(createCreditNoteAction(prev, credit())).rejects.toThrow(
      `REDIRECT /invoices/${NOTE_ID}`,
    );
    const [, path, init] = call();
    expect(path).toBe('/v1/credit-notes');
    expect((init.headers as Record<string, string>)['idempotency-key']).toBe(KEY);
    expect(JSON.parse(init.body as string)).toEqual({
      originalInvoiceId: ID,
      reason: 'Goods came back damaged.',
      lines: [{ originalLineNo: 2, quantity: '1.5' }],
    });
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/invoices');
  });

  it('refuses a missing reason or no credited line without calling the API', async () => {
    const state = await createCreditNoteAction(
      prev,
      credit({ reason: '', lines: JSON.stringify([{ lineNo: 1, quantity: '' }]) }),
    );
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.key).toBe(KEY);
    expect(state.errors['reason']).toBeTruthy();
    expect(state.errors['lines']).toBeTruthy();
  });

  it('says plainly that a credit above the cap was refused, keeps the typed values possible and rotates the key', async () => {
    mocks.apiFetch.mockImplementation(() =>
      answer(422, { error: { code: 'CREDIT_EXCEEDS_ORIGINAL' } }),
    );
    const state = await createCreditNoteAction(prev, credit());
    expect(state.error).toMatch(/more than the invoice|credit more/i);
    expect(state.error).toMatch(/earlier credit notes/i);
    expect(state.key).not.toBe(KEY);
    expect(state.key).toMatch(UUID);
  });

  it('treats a 409 that is not the in-progress one as a refusal with a reload offer', async () => {
    mocks.apiFetch.mockImplementation(() => answer(409, { error: { code: 'conflict' } }));
    const state = await createCreditNoteAction(prev, credit());
    expect(state.error).toMatch(/credit notes/i);
    expect(state.reload).toBe(true);
    expect(state.key).not.toBe(KEY);
  });

  it('keeps the key after a timeout and while the first request is still processing', async () => {
    mocks.apiFetch.mockImplementation(() => Promise.reject(new TypeError('fetch failed')));
    expect((await createCreditNoteAction(prev, credit())).key).toBe(KEY);
    mocks.apiFetch.mockImplementation(() => answer(409, IN_PROGRESS));
    const state = await createCreditNoteAction(prev, credit());
    expect(state.key).toBe(KEY);
    expect(state.error).toMatch(/still being processed/i);
  });

  it('refuses a person without invoice.credit_note', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    const state = await createCreditNoteAction(prev, credit());
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.error).toMatch(/do not include/i);
  });

  it('follows the live invoice.credit_note grant, not the role defaults', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['accountant'] });
    mocks.getMe.mockResolvedValue({
      permissions: [{ permission: 'invoice.credit_note', scope: 'all' }],
    });
    await expect(createCreditNoteAction(prev, credit())).rejects.toThrow('REDIRECT');
    expect(call()[1]).toBe('/v1/credit-notes');

    vi.clearAllMocks();
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['finance'] });
    mocks.getMe.mockResolvedValue({ permissions: [] });
    const state = await createCreditNoteAction(prev, credit());
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.error).toMatch(/do not include/i);
  });
});

describe('createDebitNoteAction', () => {
  it('posts priced-by-the-server lines with the original invoice and reason', async () => {
    await expect(createDebitNoteAction(prev, debit())).rejects.toThrow('REDIRECT');
    const [, path, init] = call();
    expect(path).toBe('/v1/debit-notes');
    expect(JSON.parse(init.body as string)).toEqual({
      originalInvoiceId: ID,
      reason: 'Late payment fee.',
      lines: [
        { description: 'Late fee', uom: 'lot', quantity: '1', unitPrice: '500', taxCodeId: TAX },
      ],
    });
  });

  it('refuses an empty reason and a line without a tax code, never reaching the API', async () => {
    const state = await createDebitNoteAction(
      prev,
      debit({
        reason: ' ',
        lines: JSON.stringify([
          {
            key: 'l1',
            description: 'Fee',
            uom: 'lot',
            quantity: '1',
            unitPrice: '5',
            taxCodeId: '',
          },
        ]),
      }),
    );
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.errors['reason']).toBeTruthy();
    expect(state.errors['lines.0.taxCodeId']).toBeTruthy();
  });

  it('refuses a person without invoice.credit_note', async () => {
    mocks.requireStaffSession.mockResolvedValue({ accessToken: 't', roles: ['sales'] });
    const state = await createDebitNoteAction(prev, debit());
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(state.error).toMatch(/do not include/i);
  });
});
