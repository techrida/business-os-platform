// @vitest-environment jsdom
// The quotation form's Vendor is a live-search pick of an invited vendor, and the optional fields say
// "Optional" beside the label instead of in a hint (UIP-FORM-008, UIP-FORM-009).
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mountForm } from '@/test/form-interactions';

import { listedOptions, pickBox, pickByTyping } from '../../pick-existing.test-helpers';
import { QuoteForm } from './quote-form';

const HIMAL = '11111111-1111-4111-8111-111111111111';
const EVEREST = '22222222-2222-4222-8222-222222222222';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

it('picks the invited vendor by typing, with no Search button, and posts its id', async () => {
  mounted = await mountForm(
    <QuoteForm
      action={vi.fn()}
      idempotencyKey="key"
      rfqId="rfq"
      mode="record"
      vendors={[
        { id: HIMAL, name: 'Himal Traders' },
        { id: EVEREST, name: 'Everest Supplies' },
      ]}
      prLines={[{ id: 'line', lineNo: 1, description: 'Chair', uom: 'pcs', quantity: '1' }]}
      taxCodes={[{ id: '33333333-3333-4333-8333-333333333333', label: 'VAT 13%' }]}
      enabledCurrencies={['NPR']}
      cancelHref="/procurement/rfqs/rfq"
      reloadHref="/procurement/rfqs/rfq/quotations/new"
    />,
  );
  const { container } = mounted;
  expect(container.textContent).not.toContain('Optional.');
  expect(container.textContent).not.toContain('(optional)');
  expect(container.textContent).toContain('Optional');
  expect(container.querySelector<HTMLInputElement>('input[name="warranty"]')?.placeholder).not.toBe(
    '',
  );

  const { fill } = await import('@/test/form-interactions');
  await fill(pickBox(container, 'vendorId'), 'ever');
  expect(listedOptions()).toEqual(['Everest Supplies']);
  await pickByTyping(container, 'vendorId', 'ever', 'Everest Supplies');
  const form = container.querySelector('form')!;
  expect(new FormData(form).get('vendorId')).toBe(EVEREST);
  expect(Array.from(container.querySelectorAll('button')).map((b) => b.textContent)).not.toContain(
    'Search',
  );
});
