// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { describeQuoteFailure } from './failure';
import { emptyValues, type BuilderValues, type Currency } from './model';
import { QuoteBuilder, type BuilderTarget } from './quote-builder';

const mocks = vi.hoisted(() => ({
  saveDraftAction: vi.fn(),
  previewQuoteAction: vi.fn(),
  submitQuoteAction: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock('./actions', () => ({
  saveDraftAction: mocks.saveDraftAction,
  previewQuoteAction: mocks.previewQuoteAction,
  submitQuoteAction: mocks.submitQuoteAction,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mocks.push, replace: mocks.replace, refresh: mocks.refresh }),
  unstable_rethrow: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

const OPP = '11111111-1111-4111-8111-111111111111';
const EDIT: BuilderTarget = {
  mode: 'edit',
  quotationId: '22222222-2222-4222-8222-222222222222',
  versionId: '33333333-3333-4333-8333-333333333333',
  expectedVersion: 4,
};

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  mocks.saveDraftAction.mockReset();
  mocks.previewQuoteAction
    .mockReset()
    .mockResolvedValue({ ok: false, kind: 'invalid', message: '' });
  mocks.submitQuoteAction.mockReset();
  mocks.error.mockReset();
  mocks.success.mockReset();
  mocks.push.mockReset();
  mocks.replace.mockReset();
  mocks.refresh.mockReset();
});
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

async function mountBuilder(opts: {
  target?: BuilderTarget;
  currency: Currency;
  enabled: readonly Currency[];
}) {
  const initial: BuilderValues = emptyValues({
    currency: opts.currency,
    issueDate: '2026-11-19',
    validUntil: '2026-12-04',
  });
  mounted = await mountForm(
    <QuoteBuilder
      target={opts.target ?? { mode: 'create', opportunityId: OPP }}
      title="Quotation"
      cancelHref="/quotations"
      initial={initial}
      context={null}
      contacts={[]}
      taxCodes={[]}
      paymentTerms={[]}
      enabledCurrencies={opts.enabled}
      idempotencyKey="44444444-4444-4444-8444-444444444444"
    />,
  );
  return mounted.container;
}

/** The Currency picker's trigger, found through its visible label. */
function currencyTrigger(): HTMLElement {
  const label = Array.from(document.querySelectorAll('label')).find((l) =>
    l.textContent?.trim().startsWith('Currency'),
  );
  if (!label) throw new Error('No Currency label');
  const byLabel = label.id
    ? document.querySelector<HTMLElement>(`button[aria-labelledby~="${label.id}"]`)
    : null;
  const trigger =
    byLabel ??
    (label.htmlFor ? document.getElementById(label.htmlFor) : null) ??
    label.parentElement?.parentElement?.querySelector('button');
  if (!(trigger instanceof HTMLElement)) throw new Error('No Currency trigger');
  return trigger;
}

async function currencyOptionLabels(): Promise<string[]> {
  await click(currencyTrigger());
  return Array.from(document.querySelectorAll('[role="option"]')).map(
    (el) => el.textContent?.trim() ?? '',
  );
}

const saveButton = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Save draft',
  ) ?? null;

describe('quote builder currency picker (D44: only enabled currencies)', () => {
  it('offers only the enabled currencies: NPR and USD, no INR', async () => {
    await mountBuilder({ currency: 'NPR', enabled: ['NPR', 'USD'] });
    expect(await currencyOptionLabels()).toEqual(['NPR', 'USD']);
  });

  it("keeps an edited quotation's own currency listed, marked, after it was switched off", async () => {
    const container = await mountBuilder({
      target: EDIT,
      currency: 'USD',
      enabled: ['NPR', 'INR'],
    });
    expect(container.textContent).toContain(
      'USD has been switched off for your company. This quotation keeps it until you choose another.',
    );
    expect(await currencyOptionLabels()).toEqual(['NPR', 'INR', 'USD (not enabled)']);
  });

  it('saves an edited quotation that keeps its switched-off currency (the API accepts it unchanged)', async () => {
    mocks.saveDraftAction.mockResolvedValue({ ok: true, version: 5 });
    const container = await mountBuilder({ target: EDIT, currency: 'USD', enabled: ['NPR'] });
    await click(saveButton(container));
    expect(mocks.saveDraftAction).toHaveBeenCalledTimes(1);
    expect(mocks.saveDraftAction.mock.calls[0]?.[0]).toMatchObject({ values: { currency: 'USD' } });
  });

  it('refuses to save a new quotation in a currency that is not enabled, and says which to choose', async () => {
    const container = await mountBuilder({ currency: 'INR', enabled: ['NPR', 'USD'] });
    await click(saveButton(container));
    expect(mocks.saveDraftAction).not.toHaveBeenCalled();
    const message = 'INR is not enabled for your company. Choose NPR or USD.';
    expect(mocks.error).toHaveBeenCalledWith(message, { id: 'quotation-action-error' });
    expect(container.textContent).toContain(message);
  });

  it("shows a new quotation's switched-off customer currency as not enabled, before any save (U16-Q7)", async () => {
    const container = await mountBuilder({ currency: 'INR', enabled: ['NPR', 'USD'] });
    expect(container.textContent).toContain(
      'INR is not enabled for your company. Choose NPR or USD.',
    );
    expect(await currencyOptionLabels()).toEqual(['NPR', 'INR (not enabled)', 'USD']);
    await click(saveButton(container));
    expect(mocks.saveDraftAction).not.toHaveBeenCalled();
  });

  it("shows the platform's 422 CURRENCY_NOT_ENABLED through the save error path", async () => {
    const failure = describeQuoteFailure(
      {
        status: 422,
        body: {
          error: {
            code: 'CURRENCY_NOT_ENABLED',
            message: 'Currency USD is not enabled for this company',
            details: { currency: 'USD' },
          },
        },
      },
      'save',
    );
    mocks.saveDraftAction.mockResolvedValue({ ok: false, ...failure, key: 'k2' });
    const container = await mountBuilder({ currency: 'USD', enabled: ['NPR', 'USD'] });
    await click(saveButton(container));
    expect(mocks.saveDraftAction).toHaveBeenCalledTimes(1);
    expect(mocks.error).toHaveBeenCalledWith(
      'USD is not enabled for your company. Choose another currency, or ask an administrator to switch it on in Settings. Nothing was saved.',
      { id: 'quotation-action-error' },
    );
  });
});

describe('saving a new quotation moves to its editor once (TR-Q8)', () => {
  const Q = '66666666-6666-4666-8666-666666666666';

  it('replaces the address with the new draft editor a single time, with no redirect thrown', async () => {
    mocks.saveDraftAction.mockResolvedValue({ ok: true, version: 1, createdId: Q });
    const container = await mountBuilder({ currency: 'NPR', enabled: ['NPR'] });
    await click(saveButton(container));
    expect(mocks.saveDraftAction).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(mocks.replace).toHaveBeenCalledWith(`/quotations/${Q}/edit?saved=1`);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it('stays on the page after saving an existing draft', async () => {
    mocks.saveDraftAction.mockResolvedValue({ ok: true, version: 5 });
    const container = await mountBuilder({ target: EDIT, currency: 'NPR', enabled: ['NPR'] });
    await click(saveButton(container));
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe('leaving with unsaved edits asks in the design-system dialog, not the browser (UIP-BUILD-002)', () => {
  async function dirtyBuilderWithLink() {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    await mountBuilder({ currency: 'NPR', enabled: ['NPR', 'USD'] });
    await click(currencyTrigger());
    await click(
      Array.from(document.querySelectorAll('[role="option"]')).find((o) =>
        o.textContent?.includes('USD'),
      ) ?? null,
    );
    const link = document.createElement('a');
    link.href = '/leads';
    link.textContent = 'Leads';
    document.body.append(link);
    return { confirmSpy, link };
  }
  const dialogButton = (label: string) =>
    Array.from(document.querySelectorAll('[role="dialog"] button')).find(
      (b) => b.textContent?.trim() === label,
    ) ?? null;

  it('holds a link click, shows the dialog, and goes only after Leave', async () => {
    const { confirmSpy, link } = await dirtyBuilderWithLink();
    await click(link);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Leave without saving?',
    );
    expect(mocks.push).not.toHaveBeenCalled();

    await click(dialogButton('Keep editing'));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(mocks.push).not.toHaveBeenCalled();

    await click(link);
    await click(dialogButton('Leave'));
    expect(mocks.push).toHaveBeenCalledWith('/leads');
    confirmSpy.mockRestore();
  });

  it('does not ask when nothing was edited', async () => {
    await mountBuilder({ currency: 'NPR', enabled: ['NPR', 'USD'] });
    const link = document.createElement('a');
    link.href = '/leads';
    document.body.append(link);
    await click(link);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
