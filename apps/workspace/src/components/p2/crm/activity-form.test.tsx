// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, fill, mountForm, submit } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 'test', roles: ['sales'] })),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const api = vi.hoisted(() => ({ createActivity: vi.fn() }));
vi.mock('./crm-api', () => api);

import { logActivityAction } from '@/app/(app)/activities/actions';

import { ActivityForm } from './activity-form';

const LEAD = '11111111-1111-4111-8111-111111111111';
const OPPORTUNITY = '22222222-2222-4222-8222-222222222222';

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  api.createActivity.mockResolvedValue({ id: 'a' });
});
afterEach(async () => {
  await mounted?.unmount();
});

const radios = () =>
  Array.from(mounted.container.querySelectorAll<HTMLButtonElement>('[role="radio"]'));
const radio = (label: string) => radios().find((r) => r.textContent === label) ?? null;
const checked = () => radios().find((r) => r.getAttribute('aria-checked') === 'true');
const subjectInput = () => mounted.container.querySelector('input[name="subject"]');

async function settle() {
  // The server action resolves on a microtask; let React apply the new state.
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

function sentBody(): Record<string, unknown> {
  const call = api.createActivity.mock.calls[0];
  if (!call) throw new Error('createActivity was not called');
  return call[1] as Record<string, unknown>;
}

it('offers Call, Meeting, Email and Note as radio buttons, Call selected, and no task or due time', async () => {
  mounted = await mountForm(
    <ActivityForm action={logActivityAction} subjectKind="leadId" subjectId={LEAD} />,
  );
  expect(radios().map((r) => r.textContent)).toEqual(['Call', 'Meeting', 'Email', 'Note']);
  expect(checked()?.textContent).toBe('Call');
  expect(mounted.container.querySelector('[role="radiogroup"]')).not.toBeNull();
  expect(mounted.container.textContent).not.toMatch(/task/i);
  expect(mounted.container.querySelector('[name="dueAt"]')).toBeNull();
  expect(mounted.container.querySelector('select')).toBeNull();
});

it('submits the kind chosen with the buttons, through the real action and parser', async () => {
  mounted = await mountForm(
    <ActivityForm action={logActivityAction} subjectKind="leadId" subjectId={LEAD} />,
  );
  await click(radio('Meeting'));
  await fill(subjectInput(), 'Walked through the revised quote');
  await submit(mounted.container);
  await settle();

  expect(api.createActivity).toHaveBeenCalledTimes(1);
  const body = sentBody();
  expect(body).toMatchObject({
    kind: 'meeting',
    subject: 'Walked through the revised quote',
    leadId: LEAD,
  });
  expect(body).not.toHaveProperty('dueAt');
});

it('gives opportunities the same form: a note posts against the opportunity', async () => {
  mounted = await mountForm(
    <ActivityForm action={logActivityAction} subjectKind="opportunityId" subjectId={OPPORTUNITY} />,
  );
  await click(radio('Note'));
  await fill(subjectInput(), 'Budget approved for Q3');
  await submit(mounted.container);
  await settle();

  expect(sentBody()).toMatchObject({ kind: 'note', opportunityId: OPPORTUNITY });
});

it('clears the subject and returns to Call after a save', async () => {
  mounted = await mountForm(
    <ActivityForm action={logActivityAction} subjectKind="leadId" subjectId={LEAD} />,
  );
  await click(radio('Email'));
  await fill(subjectInput(), 'Sent the brochure');
  await submit(mounted.container);
  await settle();

  expect(checked()?.textContent).toBe('Call');
  expect((subjectInput() as HTMLInputElement).value).toBe('');
});

it('keeps the chosen type and the text when the form is refused', async () => {
  mounted = await mountForm(
    <ActivityForm action={logActivityAction} subjectKind="leadId" subjectId={LEAD} />,
  );
  await click(radio('Email'));
  await submit(mounted.container);
  await settle();

  expect(api.createActivity).not.toHaveBeenCalled();
  expect(checked()?.textContent).toBe('Email');
  expect(mounted.container.textContent).toContain('Say what it was about');
});
