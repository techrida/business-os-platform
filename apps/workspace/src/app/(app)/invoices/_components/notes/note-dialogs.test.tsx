// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fill, mountForm } from '@/test/form-interactions';

import { CreditNoteDialog } from './note-dialogs';

vi.mock('@/app/(app)/invoices/_components/notes/actions', () => ({
  createCreditNoteAction: vi.fn(),
  createDebitNoteAction: vi.fn(),
}));
// Radix mounts its portal only when a browser opens it; render the form in place.
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogClose: ({ children }: { children: ReactNode }) => children,
}));

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

async function mount() {
  mounted = await mountForm(
    <CreditNoteDialog
      originalInvoiceId="11111111-1111-4111-8111-111111111111"
      name="INV-2083/84-00001"
      idempotencyKey="22222222-2222-4222-8222-222222222222"
      reloadHref="/invoices/1"
      lines={[
        { lineNo: 1, description: 'Design', uom: 'lot', quantity: '1.0000' },
        { lineNo: 2, description: 'Hosting', uom: 'month', quantity: '12.0000' },
      ]}
    />,
  );
  const { container } = mounted;
  const boxes = Array.from(container.querySelectorAll('label'))
    .filter((l) => l.textContent?.startsWith('Quantity to credit'))
    .map((l) => document.getElementById(l.htmlFor) as HTMLInputElement);
  const posted = () =>
    JSON.parse(new FormData(container.querySelector('form')!).get('lines') as string) as unknown;
  return { boxes, posted };
}

describe('the credit note quantities', () => {
  it('take each quantity in a spin box and accept zero, which leaves the line out', async () => {
    const { boxes, posted } = await mount();
    const [first, second] = boxes;
    expect(first?.getAttribute('role')).toBe('spinbutton');
    await fill(first!, '0');
    await act(() => Promise.resolve(first!.focus()));
    await act(() => Promise.resolve(first!.blur()));
    expect(first!.hasAttribute('aria-invalid')).toBe(false);
    await fill(second!, '2.5');
    expect(posted()).toEqual([
      { lineNo: 1, quantity: '0' },
      { lineNo: 2, quantity: '2.5' },
    ]);
  });

  it('refuses a space inside the quantity instead of joining the halves', async () => {
    const { boxes, posted } = await mount();
    await fill(boxes[0]!, '1 5');
    expect(boxes[0]!.value).toBe('');
    expect(posted()).toEqual([
      { lineNo: 1, quantity: '' },
      { lineNo: 2, quantity: '' },
    ]);
  });
});
