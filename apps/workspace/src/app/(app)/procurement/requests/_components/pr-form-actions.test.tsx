// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { fill, mountForm, submit } from '@/test/form-interactions';
import { createPrAction, updatePrAction } from '../actions';
import { EMPTY_PR_VALUES } from '../_lib/forms';
import { PrForm } from './pr-form';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/bff', () => ({
  requireStaffSession: () => Promise.resolve({ roles: ['procurement'] }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
const api = vi.hoisted(() => ({
  createPurchaseRequest: vi.fn(),
  updatePurchaseRequest: vi.fn(),
}));
vi.mock('@/lib/api-procurement', () => api);

const PROJECT = '11111111-1111-4111-8111-111111111111';
const NEXT_PROJECT = '22222222-2222-4222-8222-222222222222';
let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks();
});
afterEach(async () => {
  await mounted?.unmount();
});

it.each(['create', 'edit'] as const)(
  '%s sends the entered project through the real action to the API boundary',
  async (mode) => {
    const apiCall = mode === 'create' ? api.createPurchaseRequest : api.updatePurchaseRequest;
    // A caught API refusal keeps the form mounted without simulating Next's redirect handling.
    apiCall.mockRejectedValueOnce(new Error('API unavailable'));
    mounted = await mountForm(
      <PrForm
        action={mode === 'create' ? createPrAction : updatePrAction}
        departments={[{ id: PROJECT, name: 'Operations' }]}
        initial={{
          ...EMPTY_PR_VALUES,
          departmentId: PROJECT,
          costCenterId: PROJECT,
          justification: 'Chairs for the new office',
          requiredBy: '2026-12-01',
          budgetCode: 'OPS-26',
          projectId: mode === 'edit' ? PROJECT : '',
          lines: [
            {
              description: 'Chair',
              specification: '',
              uom: 'pcs',
              quantity: '10',
              estimatedUnitPrice: '4500.00',
            },
          ],
        }}
        mode={mode}
        idempotencyKey={PROJECT}
        prId={PROJECT}
        version={3}
        cancelHref="/"
        reloadHref="/"
      />,
    );
    await fill(mounted.container.querySelector('input[name="projectId"]'), NEXT_PROJECT);
    await submit(mounted.container);
    if (mode === 'create') {
      expect(apiCall).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        expect.objectContaining({ projectId: NEXT_PROJECT }),
        PROJECT,
      );
    } else {
      expect(apiCall).toHaveBeenCalledExactlyOnceWith(
        expect.anything(),
        PROJECT,
        expect.objectContaining({ projectId: NEXT_PROJECT }),
        PROJECT,
        3,
      );
    }
  },
);
