// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { mountNode, pickDate, posted } from '@/test/number-entry';

const sent = vi.hoisted(() => ({ forms: [] as FormData[] }));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../actions', () => ({
  // A refusal: the form is reset by React 19 after the action, so the date must be kept by the form.
  submitKycDocumentAction: async (prev: { key: string }, form: FormData) => {
    sent.forms.push(form);
    return { key: prev.key, error: 'Add the document.', fieldErrors: { file: 'Add the document.' } };
  },
}));

const { KycForm } = await import('./kyc-form');

let mounted: Awaited<ReturnType<typeof mountNode>>;
afterEach(async () => {
  await mounted.unmount();
  sent.forms.length = 0;
});

describe('KycForm valid-until date', () => {
  it('posts the picked date to the action as ISO, and keeps it after a refused submit', async () => {
    mounted = await mountNode(
      <KycForm
        idempotencyKey="7c9e6679-7425-40de-944b-e07fc1f90ae7"
        choices={[{ docType: 'tax_clearance', label: 'Tax clearance (not uploaded)' }]}
        initialDocType="tax_clearance"
        today="2026-11-10"
      />,
    );
    const { container } = mounted;
    await pickDate(container, 'validUntil', '2026-12-31');
    expect(posted(container, 'validUntil')).toBe('2026-12-31');

    const form = container.querySelector('form')!;
    await act(() =>
      Promise.resolve(form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))),
    );
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));

    expect(sent.forms).toHaveLength(1);
    expect(sent.forms[0]!.get('validUntil')).toBe('2026-12-31');
    // The refusal came back and React reset the form; the picked date is still there.
    expect(container.textContent).toContain('Add the document.');
    expect(posted(container, 'validUntil')).toBe('2026-12-31');
  });
});
