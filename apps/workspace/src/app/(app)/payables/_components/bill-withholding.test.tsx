// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { choose, click, fill, mountForm } from '@/test/form-interactions';

vi.mock('../actions', () => ({ convertSubmissionAction: vi.fn(), createBillAction: vi.fn() }));
import { withholdingOption } from '../_lib/forms';
import { BillEntryForm } from './bill-entry-form';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no layout; the combobox scrolls the highlighted option into view.
  Element.prototype.scrollIntoView = vi.fn();
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

describe('withholding options with their rate', () => {
  it('shows each code with its rate and posts the picked code id', async () => {
    const RENT = '66666666-6666-4666-8666-666666666666';
    // The codes as the API sends them, labelled by the same helper the bill pages use.
    const codes = [
      {
        id: RENT,
        code: 'TDS-5',
        name: 'Rent',
        rateBp: 500,
        effectiveFrom: '2026-07-17',
        effectiveTo: null,
      },
      {
        id: '77777777-7777-4777-8777-777777777777',
        code: 'TDS-1.5',
        name: 'Services',
        rateBp: 150,
        effectiveFrom: '2026-07-17',
        effectiveTo: null,
      },
    ].map(withholdingOption);
    mounted = await mountForm(
      <BillEntryForm
        idempotencyKey="key"
        orderLines={[]}
        taxCodes={[]}
        withholdingCodes={codes}
        cancelHref="/payables/bills"
        reloadHref="/payables/bills/new"
      />,
    );
    const { container } = mounted;
    const field = () =>
      container.querySelector<HTMLInputElement>('input[name="line:0:tdsCodeId"]')!;
    await click(field().parentElement!.querySelector('button'));
    const shown = Array.from(document.querySelectorAll('[role="option"]')).map((o) =>
      o.textContent?.trim(),
    );
    expect(shown).toEqual(['No withholding', 'TDS-5 - Rent (5%)', 'TDS-1.5 - Services (1.5%)']);
    await click(field().parentElement!.querySelector('button'));
    await choose(container, 'line:0:tdsCodeId', 'TDS-5 - Rent (5%)');
    expect(field().value).toBe(RENT);
    expect(new FormData(container.querySelector('form')!).get('line:0:tdsCodeId')).toBe(RENT);
  });
});

describe('bill expense account picker', () => {
  const OFFICE = '22222222-2222-4222-8222-222222222222';
  const TRAVEL = '33333333-3333-4333-8333-333333333333';
  const OLD = '44444444-4444-4444-8444-444444444444';
  const STRAY = '55555555-5555-4555-8555-555555555555';
  const accounts = [
    {
      id: OFFICE,
      code: '5100',
      name: 'Office supplies',
      status: 'active' as const,
      retiredAt: null,
    },
    { id: TRAVEL, code: '5200', name: 'Travel', status: 'active' as const, retiredAt: null },
    {
      id: OLD,
      code: '5900',
      name: 'Old suspense',
      status: 'retired' as const,
      retiredAt: '2026-11-01T00:00:00Z',
    },
  ];
  const mount = (over: Partial<Parameters<typeof BillEntryForm>[0]> = {}) =>
    mountForm(
      <BillEntryForm
        idempotencyKey="key"
        orderLines={[]}
        taxCodes={[]}
        expenseAccounts={accounts}
        cancelHref="/payables/bills"
        reloadHref="/payables/bills/new"
        {...over}
      />,
    );
  const combo = () => mounted!.container.querySelector<HTMLInputElement>('input[role="combobox"]')!;
  const hidden = () =>
    mounted!.container.querySelector<HTMLInputElement>('input[name="line:0:accountId"]')!;
  const optionTexts = () =>
    [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent?.trim());

  it('is a labelled combobox that filters active accounts by code or by name', async () => {
    mounted = await mount();
    const labelId = combo().getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelId)?.textContent).toBe('Expense account');
    await fill(combo(), '5200');
    expect(optionTexts()).toEqual(['5200 · Travel']);
    await fill(combo(), 'office');
    expect(optionTexts()).toEqual(['5100 · Office supplies']);
    // A retired account is not offered for a new line.
    await fill(combo(), 'suspense');
    expect(optionTexts()).not.toContain('5900 · Old suspense');
  });

  it('submits the chosen account id under the line field name', async () => {
    mounted = await mount();
    await fill(combo(), 'trav');
    const option = [...document.querySelectorAll('[role="option"]')].find(
      (o) => o.textContent?.trim() === '5200 · Travel',
    );
    await click(option ?? null);
    expect(hidden().value).toBe(TRAVEL);
    expect(combo().value).toBe('5200 · Travel');
  });

  it('shows a saved id with no match as Unknown account and keeps it unchanged', async () => {
    mounted = await mount({
      initialRows: [
        {
          poLineId: '',
          receiptLineId: '',
          accountId: STRAY,
          quantity: '1',
          unitPrice: '10',
          taxCodeId: '',
          tdsCodeId: '',
        },
      ],
    });
    expect(combo().value).toBe('Unknown account');
    expect(hidden().value).toBe(STRAY);
    expect(mounted.container.textContent).not.toContain(STRAY);
  });

  it('keeps a retired saved account selectable with its label', async () => {
    mounted = await mount({
      initialRows: [
        {
          poLineId: '',
          receiptLineId: '',
          accountId: OLD,
          quantity: '1',
          unitPrice: '10',
          taxCodeId: '',
          tdsCodeId: '',
        },
      ],
    });
    expect(combo().value).toBe('5900 · Old suspense (retired)');
    expect(hidden().value).toBe(OLD);
  });

  it('names what to add when there is no active account, with the settings link only when allowed', async () => {
    mounted = await mount({ expenseAccounts: [accounts[2]!] });
    expect(mounted.container.textContent).toContain('No expense accounts yet');
    expect(mounted.container.querySelector('a[href="/settings/company-accounts"]')).toBeNull();
    await mounted.unmount();
    mounted = await mount({ expenseAccounts: [], canManageAccounts: true });
    expect(mounted.container.querySelector('a[href="/settings/company-accounts"]')).not.toBeNull();
  });
});
