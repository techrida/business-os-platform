// @vitest-environment jsdom
import {
  LeadOwnerOptionSchema,
  OpportunityDtoSchema,
  type LeadOwnerOption,
  type OpportunityDto,
} from '@bos/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { choose, click, mountForm } from '@/test/form-interactions';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
  changeOpportunityOwner: vi.fn(),
  getOpportunity: vi.fn(),
  push: vi.fn(),
  revalidatePath: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
  useRouter: () => ({ push: mocks.push, replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: vi.fn(() => Promise.resolve({ accessToken: 'test', roles: ['sales'] })),
}));
vi.mock('@/components/p2/crm/crm-api', () => ({
  changeOpportunityOwner: mocks.changeOpportunityOwner,
  getOpportunity: mocks.getOpportunity,
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: mocks.success, error: mocks.error } }));

const { OpportunityOwnerField } = await import('./opportunity-owner-field');

const OPP = '11111111-1111-4111-8111-111111111111';
const OWNER = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const WHEN = '2026-11-08T05:45:00.000Z';

/** `GET /v1/opportunities/owners` as the API sends it: `email` is always empty there. */
const owners: LeadOwnerOption[] = [
  { userId: OWNER, displayName: 'Sita Rai', email: '' },
  { userId: OTHER, displayName: 'Ram Thapa', email: '' },
].map((o) => LeadOwnerOptionSchema.parse(o));

/** The PATCH's answer, through the contract (optional fields omitted). */
const saved: OpportunityDto = OpportunityDtoSchema.parse({
  id: OPP,
  number: 'DEAL-0001',
  name: 'Bridge works',
  customerId: '22222222-2222-4222-8222-222222222222',
  contactId: null,
  leadId: null,
  ownerUserId: OTHER,
  ownerName: 'Ram Thapa',
  stage: 'negotiation',
  stageReason: null,
  lostReason: null,
  stageNote: null,
  value: null,
  currency: 'NPR',
  probability: null,
  expectedClose: null,
  wonQuotationVersionId: null,
  version: 7,
  createdAt: WHEN,
  updatedAt: WHEN,
});

const refusal = (status: number, code: string, details?: Record<string, string>) =>
  new ApiError(status, code, {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678', details },
  });

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = vi.fn();
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function settle() {
  const { act } = await import('react');
  for (let i = 0; i < 4; i += 1) await act(() => Promise.resolve());
}

const save = (container: HTMLElement) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === 'Save owner') ?? null;

function mount() {
  return mountForm(
    <OpportunityOwnerField
      opportunityId={OPP}
      version={6}
      ownerUserId={OWNER}
      ownerName="Sita Rai"
      owners={owners}
    />,
  );
}

it('hands the deal over with the version the page showed, and says the follow-ups moved', async () => {
  mocks.changeOpportunityOwner.mockResolvedValue(saved);
  mocks.getOpportunity.mockResolvedValue(saved);
  const { container } = await mount();
  expect(container.textContent).toContain(
    "The previous owner's open follow-ups move to the new owner.",
  );
  await choose(container, 'ownerUserId', 'Ram Thapa');
  await click(save(container));
  await settle();
  expect(mocks.changeOpportunityOwner).toHaveBeenCalledExactlyOnceWith(expect.anything(), OPP, {
    ownerUserId: OTHER,
    expectedVersion: 6,
  });
  expect(mocks.success).toHaveBeenCalledWith(
    "Owner changed to Ram Thapa. The previous owner's open follow-ups moved to them.",
  );
  expect(mocks.revalidatePath).toHaveBeenCalledWith(`/opportunities/${OPP}`);
  expect(mocks.push).not.toHaveBeenCalled();
});

it('returns to the list when the hand-over takes the deal out of reach (404 on the re-read)', async () => {
  mocks.changeOpportunityOwner.mockResolvedValue(saved);
  mocks.getOpportunity.mockRejectedValue(refusal(404, 'not_found'));
  const { container } = await mount();
  await choose(container, 'ownerUserId', 'Ram Thapa');
  await click(save(container));
  await settle();
  expect(mocks.success).toHaveBeenCalledWith(
    "Handed to Ram Thapa. The previous owner's open follow-ups moved to them.",
  );
  expect(mocks.push).toHaveBeenCalledWith('/opportunities');
  // No revalidation: it would re-render this deal as not found before the move to the list.
  expect(mocks.revalidatePath).not.toHaveBeenCalled();
});

it("words the assignment rule's refusal from details.assignmentReason, next to the control", async () => {
  mocks.changeOpportunityOwner.mockRejectedValue(
    refusal(400, 'bad_request', { assignmentReason: 'other_department' }),
  );
  const { container } = await mount();
  await choose(container, 'ownerUserId', 'Ram Thapa');
  await click(save(container));
  await settle();
  const select = container.querySelector('[aria-invalid="true"]');
  expect(select).not.toBeNull();
  expect(container.textContent).toContain('The new owner is outside your department.');
  expect(mocks.getOpportunity).not.toHaveBeenCalled();
  expect(mocks.success).not.toHaveBeenCalled();
});

it('offers a reload when the deal changed underneath the page (409)', async () => {
  mocks.changeOpportunityOwner.mockRejectedValue(refusal(409, 'conflict'));
  const { container } = await mount();
  await choose(container, 'ownerUserId', 'Ram Thapa');
  await click(save(container));
  await settle();
  const [message, options] = mocks.error.mock.calls[0] as [string, { action?: { label: string } }];
  expect(message).toMatch(/reload/i);
  expect(options.action?.label).toBe('Reload');
});
