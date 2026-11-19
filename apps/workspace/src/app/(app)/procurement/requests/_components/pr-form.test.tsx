// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { choose, click, fill, mountForm, submit } from '@/test/form-interactions';
import { EMPTY_PR_VALUES, valuesFromForm } from '../_lib/forms';
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
