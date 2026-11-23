// @vitest-environment jsdom
// The Commercial terms dialogs: each sends one field with the version the page rendered (none before the first terms
// save), a refusal stays in the dialog under the field or at the top, a stale save says someone else changed it and
// keeps the dialog open, a save for a legal entity switched in another tab says so and keeps the dialog usable, and a
// save closes it with a toast. The terms dialogs send the legal entity the page was rendered for.
import { NO_SPACES } from '@bos/locale';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { choose, click, fill, mountForm } from '@/test/form-interactions';

import { ENTITY_CHANGED, LIMIT_INVALID, staleMessage, type TermsEditState } from './terms-form';
import { CreditLimitForm, OwnerForm, PaymentTermForm } from './terms-forms';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast }));

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const SITA = '22222222-2222-4222-8222-222222222222';
const RAM = '33333333-3333-4333-8333-333333333333';
const NET30 = '44444444-4444-4444-8444-444444444444';
const ENTITY = '55555555-5555-4555-8555-555555555555';
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const saves = (saved: string) =>
  vi.fn((prev: TermsEditState, _form: FormData) =>
    Promise.resolve<TermsEditState>({ errors: {}, saved, savedCount: prev.savedCount + 1 }),
  );
const refuses = (state: Omit<TermsEditState, 'savedCount'>) =>
  vi.fn((prev: TermsEditState, _form: FormData) =>
    Promise.resolve<TermsEditState>({ ...state, savedCount: prev.savedCount }),
  );

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const open = async (name: string) => {
  const trigger = Array.from(mounted!.container.querySelectorAll('button')).find(
    (b) => b.textContent === `Change ${name}`,
  );
  await click(trigger ?? null);
};
const save = () => click(dialog()?.querySelector('footer button[type="submit"]') ?? null);
/** The visible credit limit box, named by its label; the posted value is on a hidden input. */
const limitBox = (): HTMLInputElement | null => {
  const label = Array.from(dialog()?.querySelectorAll('label') ?? []).find(
    (l) => l.textContent?.trim() === 'Credit limit (NPR)',
  );
  const box = label ? document.getElementById(label.htmlFor) : null;
  return box instanceof HTMLInputElement ? box : null;
};

describe('CreditLimitForm', () => {
  it('sends the typed amount and no version before the first save, then closes with a toast', async () => {
    const action = saves('Credit limit saved.');
    mounted = await mountForm(
      <CreditLimitForm
        action={action}
        customerId={CUSTOMER}
        organizationId={ENTITY}
        version={null}
        current={null}
        entityName="Techrida Nepal"
      />,
    );
    await open('credit limit');
    expect(dialog()?.textContent).toContain('Credit limit with Techrida Nepal');
    expect(dialog()?.textContent).toContain('Credit limit (NPR)');
    await fill(limitBox(), '1,00,000.00');
    await save();

    const sent = action.mock.calls[0]![1];
    expect(sent.get('customerId')).toBe(CUSTOMER);
    expect(sent.get('organizationId')).toBe(ENTITY);
    expect(sent.get('expectedVersion')).toBe('');
    expect(sent.get('limitMode')).toBe('limit');
    expect(sent.get('creditLimit')).toBe('100000');
    expect(sent.get('currentCreditLimit')).toBe('');
    expect(toast.success).toHaveBeenCalledWith('Credit limit saved.');
    expect(dialog()).toBeNull();
  });

  it('groups a typed limit in the box, reads it in words and posts plain digits', async () => {
    const action = saves('Credit limit saved.');
    mounted = await mountForm(
      <CreditLimitForm
        action={action}
        customerId={CUSTOMER}
        organizationId={ENTITY}
        version={3}
        current={null}
        entityName="Techrida Nepal"
      />,
    );
    await open('credit limit');
    await fill(limitBox(), '1250000');
    expect(limitBox()?.value).toBe('12,50,000');
    expect(dialog()?.textContent?.toLowerCase()).toContain('twelve lakh fifty thousand');
    await save();
    expect(action.mock.calls[0]![1].get('creditLimit')).toBe('1250000');
  });

  it('says to remove the space when 10 50 is typed, and keeps it out of the box', async () => {
    const action = saves('Credit limit saved.');
    mounted = await mountForm(
      <CreditLimitForm
        action={action}
        customerId={CUSTOMER}
        organizationId={ENTITY}
        version={3}
        current={null}
        entityName="Techrida Nepal"
      />,
    );
    await open('credit limit');
    await fill(limitBox(), '10 50');
    expect(dialog()?.textContent).toContain(NO_SPACES);
    expect(limitBox()?.value).toBe('');
  });

  it('sends No limit without an amount, with the rendered version', async () => {
    const action = saves('Credit limit removed.');
    mounted = await mountForm(
      <CreditLimitForm
        action={action}
        customerId={CUSTOMER}
        organizationId={ENTITY}
        version={3}
        current="0.00"
        entityName="Techrida Nepal"
      />,
    );
    await open('credit limit');
    // The current zero limit is prefilled, not blanked.
    expect(dialog()!.querySelector<HTMLInputElement>('input[name="creditLimit"]')?.value).toBe('0');
    await click(dialog()!.querySelector('button[role="radio"][value="none"]'));
    expect(dialog()!.querySelector('input[name="creditLimit"]')).toBeNull();
    await save();
    const sent = action.mock.calls[0]![1];
    expect(sent.get('limitMode')).toBe('none');
    expect(sent.get('creditLimit')).toBeNull();
    expect(sent.get('expectedVersion')).toBe('3');
    expect(sent.get('currentCreditLimit')).toBe('0.00');
  });

  it('keeps the dialog open with the error under the field', async () => {
    mounted = await mountForm(
      <CreditLimitForm
        action={refuses({ errors: { value: LIMIT_INVALID } })}
        customerId={CUSTOMER}
        organizationId={ENTITY}
        version={3}
        current={null}
        entityName="Techrida Nepal"
      />,
    );
    await open('credit limit');
    await fill(limitBox(), '12.345');
    await save();
    expect(dialog()?.textContent).toContain(LIMIT_INVALID);
    expect(limitBox()?.getAttribute('aria-invalid')).toBe('true');
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('says someone else changed the terms, and stays open for an informed retry', async () => {
    mounted = await mountForm(
      <CreditLimitForm
        action={refuses({ errors: {}, error: staleMessage('creditLimit'), stale: true })}
        customerId={CUSTOMER}
        organizationId={ENTITY}
        version={3}
        current="500.00"
        entityName="Techrida Nepal"
      />,
    );
    await open('credit limit');
    await save();
    expect(dialog()?.textContent).toContain('Changed by someone else');
    expect(dialog()?.textContent).toContain(staleMessage('creditLimit'));
  });

  it('says the legal entity changed, keeps the draft and stays usable to cancel and reload', async () => {
    const action = refuses({ errors: {}, error: ENTITY_CHANGED, entityChanged: true });
    mounted = await mountForm(
      <CreditLimitForm
        action={action}
        customerId={CUSTOMER}
        organizationId={ENTITY}
        version={3}
        current="500.00"
        entityName="Techrida Nepal"
      />,
    );
    await open('credit limit');
    await fill(limitBox(), '900');
    await save();
    expect(action.mock.calls[0]![1].get('organizationId')).toBe(ENTITY);
    expect(dialog()?.textContent).toContain('Legal entity changed');
    expect(dialog()?.textContent).toContain(ENTITY_CHANGED);
    expect(dialog()?.textContent).not.toContain('Changed by someone else');
    // The box pads on blur; the typed amount is kept.
    expect(limitBox()?.value).toBe('900.00');
    const buttons = Array.from(dialog()!.querySelectorAll<HTMLButtonElement>('footer button'));
    expect(buttons.map((b) => [b.textContent, b.disabled])).toEqual([
      ['Cancel', false],
      ['Save', false],
    ]);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('shows the dialog hint for a zero limit: it holds an order unless credit on account covers it', async () => {
    mounted = await mountForm(
      <CreditLimitForm
        action={saves('x')}
        customerId={CUSTOMER}
        organizationId={ENTITY}
        version={3}
        current="0.00"
        entityName="Techrida Nepal"
      />,
    );
    await open('credit limit');
    const text = dialog()?.textContent ?? '';
    expect(text).toContain(
      '0.00 is a real limit: it holds any order unless the customer has enough credit on account to cover it.',
    );
    expect(text).not.toContain('holds every order');
  });
});

describe('OwnerForm', () => {
  it('offers the people list and keeps a current owner it no longer holds selectable', async () => {
    const action = saves('The account owner was changed.');
    mounted = await mountForm(
      <OwnerForm
        action={action}
        customerId={CUSTOMER}
        version={4}
        current={{ userId: SITA, name: 'Sita Rai' }}
        people={[{ userId: RAM, displayName: 'Ram Thapa' }]}
      />,
    );
    await open('account owner');
    // Selected as it is, under a label that says why it is not in the list.
    expect(dialog()?.textContent).toContain('Sita Rai (cannot be chosen again)');
    await choose(dialog()!, 'ownerUserId', 'Ram Thapa');
    await save();
    const sent = action.mock.calls[0]![1];
    expect(sent.get('ownerUserId')).toBe(RAM);
    expect(sent.get('expectedVersion')).toBe('4');
    expect(sent.get('currentOwnerUserId')).toBe(SITA);
    expect(toast.success).toHaveBeenCalledWith('The account owner was changed.');
  });
});

describe('PaymentTermForm', () => {
  it('offers No payment terms and the active terms', async () => {
    const action = saves('Payment terms cleared.');
    mounted = await mountForm(
      <PaymentTermForm
        action={action}
        customerId={CUSTOMER}
        organizationId={ENTITY}
        version={2}
        current={NET30}
        terms={[{ id: NET30, label: 'Net 30 days' }]}
        entityName="Techrida Nepal"
      />,
    );
    await open('payment terms');
    await choose(dialog()!, 'paymentTermId', 'No payment terms');
    await save();
    const sent = action.mock.calls[0]![1];
    expect(sent.get('paymentTermId')).toBe('');
    expect(sent.get('currentPaymentTermId')).toBe(NET30);
    expect(sent.get('expectedVersion')).toBe('2');
    expect(sent.get('organizationId')).toBe(ENTITY);
  });
});
