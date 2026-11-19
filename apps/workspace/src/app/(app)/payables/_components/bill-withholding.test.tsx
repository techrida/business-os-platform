// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { choose, mountForm } from '@/test/form-interactions';

vi.mock('../actions', () => ({ convertSubmissionAction: vi.fn(), createBillAction: vi.fn() }));
import { BillEntryForm } from './bill-entry-form';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

describe('bill withholding selection', () => {
  it('offers named withholding codes and an explicit no-withholding option while retaining the account GUID field', async () => {
    mounted = await mountForm(
      <BillEntryForm
        idempotencyKey="key"
        orderLines={[]}
        taxCodes={[]}
        withholdingCodes={[
          {
            id: '11111111-1111-4111-8111-111111111111',
            label: 'TDS0 - Pending accountant signoff',
          },
        ]}
        cancelHref="/payables/bills"
        reloadHref="/payables/bills/new"
      />,
    );
    const { container } = mounted;
    const field = () =>
      container.querySelector<HTMLInputElement>('input[name="line:0:tdsCodeId"]')!;
    // Nothing withheld by default: the trigger names the explicit option and the field is empty.
    expect(field().type).toBe('hidden');
    expect(field().value).toBe('');
    expect(field().parentElement!.querySelector('button')!.textContent).toContain('No withholding');
    // The user can pick the named code, which submits its id, then go back to no withholding.
    await choose(container, 'line:0:tdsCodeId', 'TDS0 - Pending accountant signoff');
    expect(field().value).toBe('11111111-1111-4111-8111-111111111111');
    await choose(container, 'line:0:tdsCodeId', 'No withholding');
    expect(field().value).toBe('');
    expect(container.querySelector('[name="line:0:accountId"]')).not.toBeNull();
    expect(container.textContent).not.toContain('Withholding code ID');
  });
});
