import type { QuotationListItem } from '@bos/contracts';
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

import NewQuotationPage from './page';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
// The page asks what the user may do (to offer Create contact); every grant is on here.
vi.mock('@/lib/live-permissions', () => ({
  getPermissionCheck: () => Promise.resolve(() => true),
}));

const mocks = vi.hoisted(() => ({
  requireStaffSession: vi.fn(),
  getOpportunity: vi.fn(),
  getCustomer: vi.fn(),
  listQuotations: vi.fn(),
  builderProps: vi.fn(),
  // The display-settings read behind the real `loadEnabledCurrencies`.
  call: vi.fn(),
  redirect: vi.fn((to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));

vi.mock('@/lib/bff', () => ({ requireStaffSession: mocks.requireStaffSession }));
vi.mock('@/components/p2/quote-builder/api', () => ({
  getOpportunity: mocks.getOpportunity,
  getCustomer: mocks.getCustomer,
}));
vi.mock('@/components/p2/quotations/api', () => ({ listQuotations: mocks.listQuotations }));
vi.mock('@/lib/api-procurement', () => ({ call: mocks.call }));
const lookups = vi.hoisted(() => ({
  loadLookups: vi.fn(),
}));
vi.mock('@/components/p2/quote-builder/lookups', () => ({ loadLookups: lookups.loadLookups }));
vi.mock('@/components/p2/quote-builder/quote-builder', () => ({
  QuoteBuilder: (props: { notice?: ReactNode }) => {
    mocks.builderProps(props);
    return <div data-testid="builder">{props.notice}</div>;
  },
}));
vi.mock('next/navigation', () => ({ notFound: vi.fn(), redirect: mocks.redirect }));

const OPP = '11111111-1111-4111-8111-111111111111';
const CUSTOMER = '33333333-3333-4333-8333-333333333333';
const Q1 = '55555555-5555-4555-8555-555555555551';
const Q2 = '55555555-5555-4555-8555-555555555552';

const quote = (id: string, over: Partial<QuotationListItem> = {}) =>
  ({
    id,
    number: `QT-${id.slice(-1)}`,
    status: 'draft',
    canEdit: true,
    ...over,
  }) as QuotationListItem;

async function render(query: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(
    await NewQuotationPage({ searchParams: Promise.resolve({ opportunityId: OPP, ...query }) }),
  );
}

beforeEach(() => {
  mocks.requireStaffSession.mockReset().mockResolvedValue({ accessToken: 'tok' });
  mocks.getOpportunity.mockReset().mockResolvedValue({
    id: OPP,
    customerId: CUSTOMER,
    contactId: null,
    currency: 'NPR',
  });
  mocks.getCustomer.mockReset().mockResolvedValue(null);
  mocks.listQuotations.mockReset().mockResolvedValue([]);
  mocks.builderProps.mockReset();
  lookups.loadLookups
    .mockReset()
    .mockResolvedValue({ contacts: [], taxCodes: [], paymentTerms: [] });
  mocks.call.mockReset().mockResolvedValue({ enabledCurrencies: ['NPR', 'INR', 'USD'] });
  mocks.redirect.mockClear();
});

describe('new quotation for an opportunity (demo feedback: the New URL made a second record)', () => {
  it('shows the builder when the opportunity has no draft to resume', async () => {
    mocks.listQuotations.mockResolvedValue([quote(Q1, { status: 'sent', canEdit: false })]);
    const html = await render();
    expect(mocks.listQuotations).toHaveBeenCalledWith(expect.anything(), { opportunityId: OPP });
    expect(mocks.builderProps).toHaveBeenCalledTimes(1);
    expect(html).not.toContain('already has a draft');
  });

  it('opens the one editable draft in its editor instead of a second quotation', async () => {
    mocks.listQuotations.mockResolvedValue([quote(Q1, { status: 'returned' })]);
    await expect(render()).rejects.toThrow(`NEXT_REDIRECT /quotations/${Q1}/edit`);
    expect(mocks.builderProps).not.toHaveBeenCalled();
  });

  it("goes to the opportunity's list when several drafts could be meant", async () => {
    mocks.listQuotations.mockResolvedValue([quote(Q1), quote(Q2)]);
    await expect(render()).rejects.toThrow(`NEXT_REDIRECT /quotations?opportunityId=${OPP}`);
    expect(mocks.builderProps).not.toHaveBeenCalled();
  });

  it('starts another quotation on purpose with another=1, and says a draft exists', async () => {
    mocks.listQuotations.mockResolvedValue([quote(Q1)]);
    const html = await render({ another: '1' });
    expect(mocks.redirect).not.toHaveBeenCalled();
    expect(mocks.builderProps).toHaveBeenCalledTimes(1);
    expect(html).toContain('This opportunity already has a draft');
    expect(html).toContain(`href="/quotations/${Q1}/edit"`);
  });

  it('does not block a new quotation when the list cannot be read', async () => {
    mocks.listQuotations.mockRejectedValue(new ApiError(403, 'no'));
    await render();
    expect(mocks.builderProps).toHaveBeenCalledTimes(1);
  });
});

describe('new quotation currencies (D44: only what the company switched on)', () => {
  const builder = () =>
    mocks.builderProps.mock.calls[0]?.[0] as {
      enabledCurrencies: string[];
      initial: { currency: string };
    };

  it('reads the enabled list once and hands it to the builder', async () => {
    mocks.call.mockResolvedValue({ enabledCurrencies: ['USD', 'NPR'] });
    await render();
    expect(mocks.call).toHaveBeenCalledTimes(1);
    expect(mocks.call).toHaveBeenCalledWith(
      expect.anything(),
      '/v1/settings/display',
      expect.anything(),
    );
    expect(builder().enabledCurrencies).toEqual(['NPR', 'USD']);
  });

  it("keeps the customer's currency when it is enabled", async () => {
    mocks.call.mockResolvedValue({ enabledCurrencies: ['NPR', 'USD'] });
    mocks.getCustomer.mockResolvedValue({ id: CUSTOMER, defaultCurrency: 'USD' });
    await render();
    expect(builder().initial.currency).toBe('USD');
  });

  it("keeps the customer's currency even when it has been switched off, never silently NPR (U16-Q7)", async () => {
    mocks.call.mockResolvedValue({ enabledCurrencies: ['NPR', 'USD'] });
    mocks.getCustomer.mockResolvedValue({ id: CUSTOMER, defaultCurrency: 'INR' });
    await render();
    expect(builder().enabledCurrencies).toEqual(['NPR', 'USD']);
    expect(builder().initial.currency).toBe('INR');
  });
});

describe('new quotation default terms (UIP-FORM-012)', () => {
  const terms = {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'terms_conditions',
    name: 'Standard terms',
    body: '<p>Net 30.</p>',
    isDefault: true,
  };
  const initial = () =>
    (mocks.builderProps.mock.calls[0]?.[0] as { initial: Record<string, string> }).initial;

  it('starts each terms field with the default saved option of its kind, and leaves the rest empty', async () => {
    lookups.loadLookups.mockResolvedValue({
      contacts: [],
      taxCodes: [],
      paymentTerms: [],
      termPresets: [
        terms,
        { ...terms, id: terms.id.replace(/1$/, '2'), name: 'Other', isDefault: undefined },
      ],
    });
    await render();
    expect(initial().termsAndConditions).toBe('<p>Net 30.</p>');
    expect(initial().scope).toBe('');
  });

  it('leaves the fields empty when no default is set', async () => {
    lookups.loadLookups.mockResolvedValue({
      contacts: [],
      taxCodes: [],
      paymentTerms: [],
      termPresets: [{ ...terms, isDefault: undefined }],
    });
    await render();
    expect(initial().termsAndConditions).toBe('');
  });
});
