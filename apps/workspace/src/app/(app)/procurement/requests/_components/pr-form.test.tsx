// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { fill, mountForm, submit } from '@/test/form-interactions';
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
