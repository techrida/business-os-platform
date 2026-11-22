// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { choose, click, fill, mountForm, submit, typeKeys } from '@/test/form-interactions';
import { EMPTY_PR_VALUES, valuesFromDto, valuesFromForm } from '../_lib/forms';
import { PrForm } from './pr-form';

const PROJECT = '11111111-1111-4111-8111-111111111111';
const NEXT_PROJECT = '22222222-2222-4222-8222-222222222222';
let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
});

it.each(['create', 'edit'] as const)(
  '%s submits a project entered through the real form',
  async (mode) => {
    const action = vi.fn((_prev, form: FormData) => {
      expect(form.get('projectId')).toBe(mode === 'create' ? PROJECT : NEXT_PROJECT);
      expect(valuesFromForm(form).projectId).toBe(mode === 'create' ? PROJECT : NEXT_PROJECT);
      return Promise.resolve({ key: PROJECT, errors: {} });
    });
    mounted = await mountForm(
      <PrForm
        action={action}
        departments={[]}
        enabledCurrencies={['NPR', 'INR', 'USD']}
        costCenters={[
          { id: PROJECT, code: 'OPS', name: 'Operations', active: true },
          { id: NEXT_PROJECT, code: 'ADMIN', name: 'Administration', active: true },
        ]}
        initial={{ ...EMPTY_PR_VALUES, projectId: mode === 'edit' ? PROJECT : '' }}
        mode={mode}
        idempotencyKey={PROJECT}
        cancelHref="/"
        reloadHref="/"
      />,
    );
    const input = mounted.container.querySelector('input[name="projectId"]');
    expect(input).not.toHaveProperty('readOnly', true);
    expect(input).not.toHaveProperty('type', 'hidden');
    await fill(input, mode === 'create' ? PROJECT : NEXT_PROJECT);
    await submit(mounted.container);
    expect(action).toHaveBeenCalledTimes(1);
  },
);

it('edit clears an assigned project in submitted FormData', async () => {
  const action = vi.fn((_prev, form: FormData) => {
    expect(form.get('projectId')).toBe('');
    expect(valuesFromForm(form).projectId).toBe('');
    return Promise.resolve({ key: PROJECT, errors: {} });
  });
  mounted = await mountForm(
    <PrForm
      action={action}
      departments={[]}
      enabledCurrencies={['NPR', 'INR', 'USD']}
      costCenters={[
        { id: PROJECT, code: 'OPS', name: 'Operations', active: true },
        { id: NEXT_PROJECT, code: 'ADMIN', name: 'Administration', active: true },
      ]}
      initial={{ ...EMPTY_PR_VALUES, projectId: PROJECT }}
      mode="edit"
      idempotencyKey={PROJECT}
      cancelHref="/"
      reloadHref="/"
    />,
  );
  await fill(mounted.container.querySelector('input[name="projectId"]'), '');
  await submit(mounted.container);
  expect(action).toHaveBeenCalledTimes(1);
});

it('edit submits a corrected cost centre through the real form', async () => {
  const action = vi.fn((_prev, form: FormData) => {
    expect(form.get('costCenterId')).toBe(NEXT_PROJECT);
    expect(valuesFromForm(form).costCenterId).toBe(NEXT_PROJECT);
    return Promise.resolve({ key: PROJECT, errors: {} });
  });
  mounted = await mountForm(
    <PrForm
      action={action}
      departments={[]}
      enabledCurrencies={['NPR', 'INR', 'USD']}
      costCenters={[
        { id: PROJECT, code: 'OPS', name: 'Operations', active: true },
        { id: NEXT_PROJECT, code: 'ADMIN', name: 'Administration', active: true },
      ]}
      initial={{ ...EMPTY_PR_VALUES, costCenterId: PROJECT }}
      mode="edit"
      idempotencyKey={PROJECT}
      prId={PROJECT}
      version={3}
      cancelHref="/"
      reloadHref="/"
    />,
  );
  // The dropdown submits through a hidden field; its trigger and list stay interactive and required.
  const input = mounted.container.querySelector<HTMLInputElement>('input[name="costCenterId"]')!;
  const trigger = input.parentElement!.querySelector('button')!;
  expect(input.value).toBe(PROJECT);
  expect(trigger.disabled).toBe(false);
  expect(trigger.textContent).toContain('OPS · Operations');
  expect(input.parentElement!.querySelector('select')).toHaveProperty('required', true);
  await choose(mounted.container, 'costCenterId', 'ADMIN · Administration');
  expect(input.value).toBe(NEXT_PROJECT);
  await submit(mounted.container);
  expect(action).toHaveBeenCalledTimes(1);
});

describe('currency picker (D44)', () => {
  /** The values and visible labels the user can pick, read by opening the shared Select. */
  async function currencyOptions(container: HTMLElement) {
    const field = container.querySelector('input[type="hidden"][name="currency"]');
    await click(field?.parentElement?.querySelector('button') ?? null);
    return Array.from(document.querySelectorAll('[role="option"]')).map((el) =>
      el.textContent?.trim(),
    );
  }

  it('create offers only the enabled currencies', async () => {
    mounted = await mountForm(
      <PrForm
        action={vi.fn()}
        departments={[]}
        enabledCurrencies={['NPR', 'USD']}
        costCenters={[{ id: PROJECT, code: 'OPS', name: 'Operations', active: true }]}
        initial={EMPTY_PR_VALUES}
        mode="create"
        idempotencyKey={PROJECT}
        cancelHref="/"
        reloadHref="/"
      />,
    );
    expect(await currencyOptions(mounted.container)).toEqual(['NPR', 'USD']);
  });

  it('edit keeps a request in a switched-off currency and submits it unchanged', async () => {
    const action = vi.fn((_prev, form: FormData) => {
      expect(form.get('currency')).toBe('INR');
      return Promise.resolve({ key: PROJECT, errors: {} });
    });
    mounted = await mountForm(
      <PrForm
        action={action}
        departments={[]}
        enabledCurrencies={['NPR', 'USD']}
        costCenters={[{ id: PROJECT, code: 'OPS', name: 'Operations', active: true }]}
        initial={{ ...EMPTY_PR_VALUES, costCenterId: PROJECT, currency: 'INR' }}
        mode="edit"
        idempotencyKey={PROJECT}
        prId={PROJECT}
        version={3}
        cancelHref="/"
        reloadHref="/"
      />,
    );
    const field = mounted.container.querySelector<HTMLInputElement>(
      'input[type="hidden"][name="currency"]',
    )!;
    expect(field.value).toBe('INR');
    expect(await currencyOptions(mounted.container)).toEqual(['NPR', 'INR (not enabled)', 'USD']);
    await submit(mounted.container);
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe('line items', () => {
  const mount = (action = vi.fn()) =>
    mountForm(
      <PrForm
        action={action}
        departments={[]}
        enabledCurrencies={['NPR', 'INR', 'USD']}
        costCenters={[{ id: PROJECT, code: 'OPS', name: 'Operations', active: true }]}
        initial={EMPTY_PR_VALUES}
        mode="create"
        idempotencyKey={PROJECT}
        cancelHref="/"
        reloadHref="/"
      />,
    );
  const button = (container: HTMLElement, name: string) =>
    Array.from(container.querySelectorAll('button')).find(
      (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name,
    ) ?? null;

  it('names each line as a group with labelled fields, keeps the submitted names and has no remove on one line', async () => {
    mounted = await mount();
    // The posted name sits on a hidden input; the label names the visible box beside it.
    const posted = mounted.container.querySelector<HTMLInputElement>(
      'input[type="hidden"][name="lines.0.quantity"]',
    )!;
    const qty = posted.parentElement!.querySelector<HTMLInputElement>('input[role="spinbutton"]')!;
    expect(mounted.container.querySelector(`label[for="${qty.id}"]`)?.textContent).toBe('Quantity');
    const group = qty.closest('[role="group"]')!;
    expect(
      mounted.container.querySelector(`#${group.getAttribute('aria-labelledby')}`)?.textContent,
    ).toBe('Line 1');
    expect(button(mounted.container, 'Remove line 1')).toBeNull();
    // The card eyebrows are decoration.
    for (const eyebrow of ['01 · The basics', '02 · The items']) {
      const el = Array.from(mounted.container.querySelectorAll('[aria-hidden="true"]')).find(
        (e) => e.textContent === eyebrow,
      );
      expect(el).toBeDefined();
    }
  });

  it('the quantity groups as typed, steps with both buttons and posts the plain number', async () => {
    const action = vi.fn((_prev, form: FormData) => {
      expect(form.get('lines.0.quantity')).toBe('1250001');
      expect(form.get('lines.0.estimatedUnitPrice')).toBe('4500');
      return Promise.resolve({ key: PROJECT, errors: {} });
    });
    mounted = await mount(action);
    await fill(mounted.container.querySelector('input[name="lines.0.uom"]'), 'pcs');
    const posted = mounted.container.querySelector<HTMLInputElement>(
      'input[type="hidden"][name="lines.0.quantity"]',
    )!;
    const root = posted.parentElement!;
    const box = root.querySelector<HTMLInputElement>('input[role="spinbutton"]')!;
    await typeKeys(box, '1250000');
    expect(box.value).toBe('12,50,000');
    expect(box.hasAttribute('name')).toBe(false);
    expect(posted.value).toBe('1250000');
    expect(root.textContent).toContain('pcs');
    const decrease = root.querySelector('button[aria-label="Decrease quantity"]');
    const increase = root.querySelector('button[aria-label="Increase quantity"]');
    expect(decrease).not.toBeNull();
    expect(increase).not.toBeNull();
    await click(increase);
    await click(increase);
    await click(decrease);
    expect(box.value).toBe('12,50,001');
    const price = mounted.container
      .querySelector('input[type="hidden"][name="lines.0.estimatedUnitPrice"]')!
      .parentElement!.querySelector<HTMLInputElement>('input[type="text"]')!;
    await typeKeys(price, '4500');
    await submit(mounted.container);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('Add items adds a row; removing the first keeps what was typed in the second', async () => {
    const action = vi.fn((_prev, form: FormData) => {
      expect(form.get('lines.0.description')).toBe('Desk');
      expect(form.get('lines.1.description')).toBeNull();
      return Promise.resolve({ key: PROJECT, errors: {} });
    });
    mounted = await mount(action);
    await click(button(mounted.container, '+ Add items'));
    await fill(mounted.container.querySelector('input[name="lines.0.description"]'), 'Chair');
    await fill(mounted.container.querySelector('input[name="lines.1.description"]'), 'Desk');
    await click(button(mounted.container, 'Remove line 1'));
    expect(
      mounted.container.querySelector<HTMLInputElement>('input[name="lines.0.description"]')!.value,
    ).toBe('Desk');
    await submit(mounted.container);
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe('editing a stored request', () => {
  it('shows and posts a stored 100000.000 without the extra zeros, with the currency said once', async () => {
    const action = vi.fn((_prev, form: FormData) => {
      expect(form.get('lines.0.quantity')).toBe('100000');
      expect(form.get('lines.0.estimatedUnitPrice')).toBe('100000');
      return Promise.resolve({ key: PROJECT, errors: {} });
    });
    const initial = valuesFromDto({
      requestType: 'goods',
      departmentId: '',
      costCenterId: PROJECT,
      justification: 'Office chairs',
      requiredBy: '2026-12-01',
      deliveryLocation: null,
      budgetCode: 'B',
      projectId: null,
      currency: 'NPR',
      isEmergency: false,
      emergencyReason: null,
      lines: [
        {
          description: 'Chair',
          specification: null,
          uom: 'pcs',
          quantity: '100000.000',
          estimatedUnitPrice: '100000.000',
        },
      ],
    });
    mounted = await mountForm(
      <PrForm
        action={action}
        departments={[]}
        enabledCurrencies={['NPR']}
        costCenters={[{ id: PROJECT, code: 'OPS', name: 'Operations', active: true }]}
        initial={initial}
        mode="edit"
        idempotencyKey={PROJECT}
        cancelHref="/"
        reloadHref="/"
      />,
    );
    const boxOf = (name: string) =>
      mounted.container
        .querySelector(`input[type="hidden"][name="${name}"]`)!
        .parentElement!.querySelector<HTMLInputElement>('input[type="text"]')!;
    const qty = boxOf('lines.0.quantity');
    const price = boxOf('lines.0.estimatedUnitPrice');
    expect(qty.value).toBe('1,00,000');
    expect(price.value).toBe('1,00,000.00');
    const priceLabel = mounted.container.querySelector(`label[for="${price.id}"]`);
    expect(priceLabel?.textContent).toBe('Estimated unit price');
    expect(price.parentElement!.textContent).toContain('NPR');
    await submit(mounted.container);
    expect(action).toHaveBeenCalledTimes(1);
  });
});

describe('needed by', () => {
  it('is a date picker with a calendar button that posts the ISO date', async () => {
    const action = vi.fn((_prev, form: FormData) => {
      expect(form.get('requiredBy')).toBe('2026-12-01');
      return Promise.resolve({ key: PROJECT, errors: {} });
    });
    mounted = await mountForm(
      <PrForm
        action={action}
        departments={[]}
        enabledCurrencies={['NPR']}
        costCenters={[{ id: PROJECT, code: 'OPS', name: 'Operations', active: true }]}
        initial={{ ...EMPTY_PR_VALUES, requiredBy: '2026-12-01' }}
        mode="create"
        idempotencyKey={PROJECT}
        cancelHref="/"
        reloadHref="/"
      />,
    );
    const field = mounted.container.querySelector<HTMLInputElement>('input[name="requiredBy"]')!;
    expect(mounted.container.querySelector('button[aria-label="Calendar"]')).not.toBeNull();
    // The visible field is segmented; the posted value stays ISO whatever the display locale.
    expect(field.value).toBe('2026-12-01');
    await submit(mounted.container);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('keeps the typed segments and says "Finish the date" when Save draft is pressed with the day cleared', async () => {
    const action = vi.fn(() => Promise.resolve({ key: PROJECT, errors: {} }));
    mounted = await mountForm(
      <PrForm
        action={action}
        departments={[]}
        enabledCurrencies={['NPR']}
        costCenters={[{ id: PROJECT, code: 'OPS', name: 'Operations', active: true }]}
        initial={{ ...EMPTY_PR_VALUES, requiredBy: '2027-12-15' }}
        mode="create"
        idempotencyKey={PROJECT}
        cancelHref="/"
        reloadHref="/"
      />,
    );
    const segment = (type: string) =>
      mounted.container.querySelector<HTMLElement>(`[data-type="${type}"]`)!;
    await act(() => Promise.resolve(segment('day').focus()));
    for (let i = 0; i < 4 && !segment('day').hasAttribute('data-placeholder'); i++) {
      await act(() =>
        Promise.resolve(
          segment('day').dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true }),
          ),
        ),
      );
    }
    expect(segment('day').hasAttribute('data-placeholder')).toBe(true);
    await submit(mounted.container);

    // Old code sent the form on with an empty date; the action reset it and every segment came back empty.
    expect(action).not.toHaveBeenCalled();
    expect(
      Array.from(mounted.container.querySelectorAll('[role="alert"]')).some(
        (node) => node.textContent === 'Finish the date',
      ),
    ).toBe(true);
    expect(document.activeElement).toBe(segment('day'));
    expect(segment('month').hasAttribute('data-placeholder')).toBe(false);
    expect(segment('year').textContent).toBe('2027');
  });
});
