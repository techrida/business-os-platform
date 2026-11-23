// @vitest-environment jsdom
// UIP-FORM-008/009 on the quote builder: the Contact field is a search-as-you-type combobox (no Search button, rows
// show the title and email), its last row is Create "<typed>" which opens the add-contact dialog with the name
// filled in, and no field says "Optional." under its box (the marker sits beside the label).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ContactFormState } from '@/components/p2/customers/form-state';
import { click, fill, mountForm } from '@/test/form-interactions';

import { emptyValues } from './model';
import { QuoteBuilder } from './quote-builder';

vi.mock('./actions', () => ({
  saveDraftAction: vi.fn(),
  previewQuoteAction: vi.fn().mockResolvedValue({ ok: false, kind: 'invalid', message: '' }),
  submitQuoteAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  unstable_rethrow: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const ASHA = '33333333-3333-4333-8333-333333333333';
const NEW = '55555555-5555-4555-8555-555555555555';
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Element.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

async function mountBuilder() {
  const action = vi.fn<(prev: ContactFormState, form: FormData) => Promise<ContactFormState>>(
    (prev, form) =>
      Promise.resolve({
        ...prev,
        errors: {},
        saved: `${form.get('fullName') as string} was added.`,
        contactId: NEW,
        savedCount: prev.savedCount + 1,
      }),
  );
  mounted = await mountForm(
    <QuoteBuilder
      target={{ mode: 'create', opportunityId: '22222222-2222-4222-8222-222222222222' }}
      title="Quotation"
      cancelHref="/quotations"
      initial={emptyValues({ currency: 'NPR', issueDate: '2026-11-19', validUntil: '2026-12-04' })}
      context={null}
      contacts={[
        {
          id: ASHA,
          label: 'Asha Rai · Buyer · asha@acme.test',
          name: 'Asha Rai',
          detail: 'Buyer · asha@acme.test',
        },
      ]}
      createContact={{ action, customerId: CUSTOMER }}
      taxCodes={[]}
      paymentTerms={[]}
      enabledCurrencies={['NPR']}
      idempotencyKey="44444444-4444-4444-8444-444444444444"
    />,
  );
  const container = mounted.container;
  const contactField = container.querySelector<HTMLInputElement>('input[name="contactId"]')!;
  return {
    action,
    container,
    hidden: contactField,
    box: contactField.parentElement!.querySelector<HTMLInputElement>('input[role="combobox"]')!,
  };
}

const options = () =>
  Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent?.trim());

it('searches contacts as you type and chooses one', async () => {
  const t = await mountBuilder();
  expect(
    Array.from(t.container.querySelectorAll('button')).some((b) =>
      /search/i.test(b.textContent ?? ''),
    ),
  ).toBe(false);
  await fill(t.box, 'buyer');
  expect(options()).toEqual([expect.stringContaining('Asha Rai'), 'Create "buyer"']);
  expect(options()[0]).toContain('asha@acme.test');
  await click(document.querySelector('[role="option"]'));
  expect(t.hidden.value).toBe(ASHA);
});

it('Create "<typed>" opens the add-contact dialog with the name and chooses the saved contact', async () => {
  const t = await mountBuilder();
  await fill(t.box, 'Zed Zee');
  expect(options()).toEqual(['Create "Zed Zee"']);
  await click(document.querySelector('[role="option"]'));
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
  expect(dialog.querySelector<HTMLInputElement>('input[name="fullName"]')!.value).toBe('Zed Zee');
  await click(dialog.querySelector('footer button[type="submit"]'));
  expect(t.action).toHaveBeenCalledTimes(1);
  expect(t.hidden.value).toBe(NEW);
});

it('marks the optional fields beside their labels and says "Optional." nowhere', async () => {
  const t = await mountBuilder();
  const row = (text: string) =>
    Array.from(t.container.querySelectorAll('label')).find((l) => l.textContent === text)
      ?.parentElement?.textContent;
  expect(row('Contact')).toBe('ContactOptional');
  expect(row('Scope')).toBe('ScopeOptional');
  expect(row('Issue date')).toBe('Issue date');
  expect(t.container.textContent).not.toContain('Optional.');
  expect(t.container.textContent).not.toContain('Required.');
});
