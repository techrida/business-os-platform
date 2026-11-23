// @vitest-environment jsdom
import type { CountryCode } from '@bos/contracts';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm, submit, typeKeys } from '@/test/form-interactions';

import { ContactForm, PRIMARY_TAKEN_REASON } from './contact-form';
import type { ContactFormState } from './form-state';
import { readPhoneRows } from './forms';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast }));

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no layout, so no scrollIntoView; the country list calls it on the highlighted option.
  Element.prototype.scrollIntoView = () => {};
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
});

async function mount(
  props: {
    hasPrimary?: boolean;
    requireEmail?: boolean;
    inDialog?: boolean;
    customerCountry?: CountryCode;
  },
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
      {...(props.customerCountry ? { customerCountry: props.customerCountry } : {})}
    />,
  );
  return mounted.container;
}

const box = (root: HTMLElement) =>
  root.querySelector<HTMLButtonElement>('button[role="checkbox"]')!;

const phoneBox = (root: ParentNode, n: number, part: 'number' | 'country' = 'number') =>
  root.querySelector<HTMLInputElement>(`input[aria-label="Phone ${n} ${part}"]`);

/** Types an international number the way a person does: `+` first, then the rest. */
async function typeInternational(root: ParentNode, n: number, rest: string) {
  await typeKeys(phoneBox(root, n), '+');
  await typeKeys(phoneBox(root, n), rest);
}

/** The contact's own Country box, found through its visible label. */
function countryBox(root: HTMLElement) {
  const label = [...root.querySelectorAll('label')].find((l) => l.textContent === 'Country');
  return root.querySelector<HTMLInputElement>(`[id="${label?.htmlFor}"]`)!;
}

async function pickCountry(input: HTMLInputElement, search: string) {
  await act(() => Promise.resolve(input.focus()));
  await act(() => Promise.resolve(input.select()));
  await typeKeys(input, search);
  await act(() =>
    Promise.resolve(
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    ),
  );
}

function recordingAction() {
  return vi.fn<(prev: ContactFormState, form: FormData) => Promise<ContactFormState>>((prev) =>
    Promise.resolve(prev),
  );
}

const postedPhones = (form: FormData | undefined) =>
  readPhoneRows(form!, 'phones').map(({ country, e164, isPrimary }) => ({
    country,
    e164,
    isPrimary,
  }));

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
    expect(box(root).getAttribute('aria-checked')).toBe('true');
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

describe('the phones and country of a new contact (FX9)', () => {
  it('posts two phones in different countries', async () => {
    const action = recordingAction();
    const root = await mount({}, action);
    await fill(root.querySelector('[name="fullName"]'), 'Sita Rai');
    await typeKeys(phoneBox(root, 1), '9812345678');
    await click(root.querySelector('button[data-action="add"]'));
    await typeInternational(root, 2, '1 4155552671');
    await submit(root);
    expect(postedPhones(action.mock.calls[0]?.[1])).toEqual([
      { country: 'NP', e164: '+9779812345678', isPrimary: true },
      { country: 'US', e164: '+14155552671', isPrimary: false },
    ]);
  });

  it('posts +1 4155552671 typed into a Nepal row as a US number', async () => {
    const action = recordingAction();
    const root = await mount({}, action);
    expect(phoneBox(root, 1, 'country')?.value).toBe('+977');
    await typeInternational(root, 1, '1 4155552671');
    await submit(root);
    expect(postedPhones(action.mock.calls[0]?.[1])).toEqual([
      { country: 'US', e164: '+14155552671', isPrimary: true },
    ]);
  });

  it("starts in the customer's country, for the contact and its first phone", async () => {
    const action = recordingAction();
    const root = await mount({ customerCountry: 'IN' }, action);
    expect(countryBox(root).getAttribute('aria-labelledby')).toBeTruthy();
    expect(phoneBox(root, 1, 'country')?.value).toBe('+91');
    await fill(root.querySelector('[name="fullName"]'), 'Sita Rai');
    await submit(root);
    expect(action.mock.calls[0]?.[1].get('country')).toBe('IN');
  });

  it('starts in Nepal when the customer country is not given', async () => {
    const action = recordingAction();
    const root = await mount({}, action);
    await submit(root);
    expect(action.mock.calls[0]?.[1].get('country')).toBe('NP');
  });

  it('posts a country chosen for the contact', async () => {
    const action = recordingAction();
    const root = await mount({ customerCountry: 'IN' }, action);
    await pickCountry(countryBox(root), 'United States');
    await submit(root);
    expect(action.mock.calls[0]?.[1].get('country')).toBe('US');
  });

  it("clears the phones and puts back the customer's country after a save", async () => {
    const action = recordingAction();
    action.mockImplementationOnce((prev) =>
      Promise.resolve({ ...prev, saved: 'Sita Rai was added.', savedCount: prev.savedCount + 1 }),
    );
    const root = await mount({ customerCountry: 'IN' }, action);
    await fill(root.querySelector('[name="fullName"]'), 'Sita Rai');
    await pickCountry(countryBox(root), 'United States');
    await typeInternational(root, 1, '977 9812345678');
    await click(root.querySelector('button[data-action="add"]'));
    await typeInternational(root, 2, '1 4155552671');
    await submit(root);
    expect(postedPhones(action.mock.calls[0]?.[1])).toHaveLength(2);
    expect(action.mock.calls[0]?.[1].get('country')).toBe('US');

    expect(root.querySelectorAll('li[data-row]')).toHaveLength(1);
    expect(phoneBox(root, 1)?.value).toBe('');
    expect(root.querySelector<HTMLInputElement>('[name="country"]')?.value).toBe('IN');
    await submit(root);
    expect(postedPhones(action.mock.calls[1]?.[1])).toEqual([]);
    expect(action.mock.calls[1]?.[1].get('country')).toBe('IN');
  });

  it('shows phone refusals on the list and on their row', async () => {
    const root = await mount({}, (prev) =>
      Promise.resolve({
        ...prev,
        errors: {
          phones: 'Mark one number as primary.',
          phoneRows: ['This number is already listed.'],
        },
      }),
    );
    await typeKeys(phoneBox(root, 1), '9812345678');
    await submit(root);
    expect(root.textContent).toContain('Mark one number as primary.');
    expect(root.textContent).toContain('This number is already listed.');
    expect(phoneBox(root, 1)?.getAttribute('aria-invalid')).toBe('true');
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
      unobserve() {}
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
  expect(dialog?.querySelector<HTMLButtonElement>('button[role="checkbox"]')?.disabled).toBe(true);

  await fill(fullName, 'Sita Rai');
  await typeInternational(dialog!, 1, '1 4155552671');
  await click(footerSubmit);
  expect(action.mock.calls[0]?.[1].get('fullName')).toBe('Sita Rai');
  // React resets the form after the refused action; the typed number stays.
  expect(dialog?.querySelector<HTMLInputElement>('[name="phones.0.number"]')?.value).toBe(
    '+14155552671',
  );
  expect(phoneBox(dialog!, 1)?.value).toBe('4155552671');
  expect(action.mock.calls[0]?.[1].get('requireEmail')).toBe('yes');
  expect(fullName?.value).toBe('Sita Rai');
  expect(email?.getAttribute('aria-invalid')).toBe('true');

  await fill(email, 'sita@example.test');
  await click(footerSubmit);
  expect(action.mock.calls[1]?.[1].get('email')).toBe('sita@example.test');
  expect(postedPhones(action.mock.calls[1]?.[1])).toEqual([
    { country: 'US', e164: '+14155552671', isPrimary: true },
  ]);
  expect(toast.success).toHaveBeenCalledWith('Contact added.');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
