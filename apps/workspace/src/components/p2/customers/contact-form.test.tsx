// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm, submit } from '@/test/form-interactions';

import { ContactForm, PRIMARY_TAKEN_REASON } from './contact-form';
import type { ContactFormState } from './form-state';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast }));

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

async function mount(
  props: { hasPrimary?: boolean; requireEmail?: boolean; inDialog?: boolean },
  action: (prev: ContactFormState, form: FormData) => Promise<ContactFormState> = (prev) =>
    Promise.resolve(prev),
) {
  mounted = await mountForm(
    <ContactForm
      action={action}
      customerId={CUSTOMER}
      idempotencyKey={KEY}
      hasPrimary={props.hasPrimary ?? false}
      requireEmail={props.requireEmail ?? false}
      inDialog={props.inDialog ?? false}
    />,
  );
  return mounted.container;
}

const box = (root: HTMLElement) =>
  root.querySelector<HTMLInputElement>('input[type="checkbox"][name="isPrimary"]')!;

describe('the main-contact box (demo feedback: a second primary answered 409)', () => {
  it('is off, with its reason linked, when the customer already has a main contact', async () => {
    const root = await mount({ hasPrimary: true });
    expect(box(root).disabled).toBe(true);
    const reasonId = box(root).getAttribute('aria-describedby');
    expect(reasonId).toBeTruthy();
    expect(root.querySelector(`[id="${reasonId}"]`)?.textContent).toBe(PRIMARY_TAKEN_REASON);
  });

  it('can be ticked when there is no main contact yet', async () => {
    const root = await mount({ hasPrimary: false });
    expect(box(root).disabled).toBe(false);
    expect(box(root).hasAttribute('aria-describedby')).toBe(false);
    await click(box(root));
    expect(box(root).checked).toBe(true);
  });

  it('shows a lost race as an error toast, not an inline alert', async () => {
    const root = await mount({}, (prev) =>
      Promise.resolve({ ...prev, primaryTaken: 'This customer already has a main contact.' }),
    );
    await fill(root.querySelector('[name="fullName"]'), 'Sita Rai');
    await submit(root);
    expect(toast.error).toHaveBeenCalledWith('This customer already has a main contact.');
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });
});

describe('the email of a new contact', () => {
  it('is a typed, required field while the customer has no contact with an email', async () => {
    const root = await mount({ requireEmail: true });
    const email = root.querySelector<HTMLInputElement>('input[name="email"]')!;
    expect(email.type).toBe('email');
    expect(email.required).toBe(true);
    expect(root.textContent).toContain('Required: quotations are sent to it.');
    expect(root.querySelector<HTMLInputElement>('input[name="requireEmail"]')?.value).toBe('yes');
  });

  it('is optional once the customer has one', async () => {
    const root = await mount({ requireEmail: false });
    const email = root.querySelector<HTMLInputElement>('input[name="email"]')!;
    expect(email.type).toBe('email');
    expect(email.required).toBe(false);
    expect(root.querySelector('input[name="requireEmail"]')).toBeNull();
  });
});

it('confirms a saved contact with a success toast and clears the form', async () => {
  const root = await mount({}, (prev) =>
    Promise.resolve({
      ...prev,
      saved: 'Sita Rai was added.',
      savedCount: prev.savedCount + 1,
    }),
  );
  await fill(root.querySelector('[name="fullName"]'), 'Sita Rai');
  await submit(root);
  expect(toast.success).toHaveBeenCalledWith('Sita Rai was added.');
  expect(root.querySelector<HTMLInputElement>('[name="fullName"]')?.value).toBe('');
});

it('submits from the dialog footer, keeping a refused draft and closing after a save', async () => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const action = vi.fn<(prev: ContactFormState, form: FormData) => Promise<ContactFormState>>();
  action.mockImplementationOnce((prev) =>
    Promise.resolve({ ...prev, errors: { email: 'Enter an email address.' } }),
  );
  action.mockImplementationOnce((prev) =>
    Promise.resolve({
      ...prev,
      errors: {},
      saved: 'Contact added.',
      savedCount: prev.savedCount + 1,
    }),
  );
  const root = await mount({ inDialog: true, requireEmail: true, hasPrimary: true }, action);

  await click(root.querySelector('[aria-haspopup="dialog"]'));
  const dialog = document.querySelector('[role="dialog"]');
  const fullName = dialog?.querySelector<HTMLInputElement>('[name="fullName"]') ?? null;
  const email = dialog?.querySelector<HTMLInputElement>('[name="email"]') ?? null;
  const footerSubmit = dialog?.querySelector('footer button[type="submit"]') ?? null;
  expect(email?.required).toBe(true);
  expect(dialog?.querySelector<HTMLInputElement>('[name="isPrimary"]')?.disabled).toBe(true);

  await fill(fullName, 'Sita Rai');
  await click(footerSubmit);
  expect(action.mock.calls[0]?.[1].get('fullName')).toBe('Sita Rai');
  expect(action.mock.calls[0]?.[1].get('requireEmail')).toBe('yes');
  expect(fullName?.value).toBe('Sita Rai');
  expect(email?.getAttribute('aria-invalid')).toBe('true');

  await fill(email, 'sita@example.test');
  await click(footerSubmit);
  expect(action.mock.calls[1]?.[1].get('email')).toBe('sita@example.test');
  expect(toast.success).toHaveBeenCalledWith('Contact added.');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
