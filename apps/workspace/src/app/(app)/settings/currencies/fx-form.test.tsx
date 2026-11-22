// @vitest-environment jsdom
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { mountForm, submit, typeKeys } from '@/test/form-interactions';

// The exchange-rate box is a DecimalInput with RATE_LIMITS (12 digits, 6 decimals): it refuses a letter or a seventh
// decimal as it is typed, and a hidden input posts the plain rate under the field name the action reads.

const actions = vi.hoisted(() => ({ addFxRateAction: vi.fn() }));
vi.mock('./actions', () => actions);
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { FxForm } = await import('./fx-form');

const TODAY = '2026-11-20';

function rateBox(container: HTMLElement): HTMLInputElement {
  const label = Array.from(container.querySelectorAll('label')).find(
    (l) => l.textContent?.trim() === 'Rate (NPR for 1 unit)',
  );
  const box = label ? document.getElementById(label.htmlFor) : null;
  if (!(box instanceof HTMLInputElement)) throw new Error('No rate box');
  return box;
}

const posted = (container: HTMLElement) =>
  new FormData(container.querySelector('form')!).get('rateNpr');

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('FxForm', () => {
  it('posts the plain rate from a hidden input, refusing a letter and a seventh decimal', async () => {
    const mounted = await mountForm(<FxForm today={TODAY} />);
    const { container } = mounted;
    expect(container.querySelector('input[type="number"]')).toBeNull();
    const field = container.querySelector<HTMLInputElement>('input[name="rateNpr"]');
    expect(field?.type).toBe('hidden');
    const box = rateBox(container);
    expect(box.name).toBe('');
    expect(box.hasAttribute('pattern')).toBe(false);
    expect(box.required).toBe(true);

    await typeKeys(box, '13a3.5');
    expect(box.value).toBe('133.5');
    expect(posted(container)).toBe('133.5');

    await typeKeys(box, '{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}1.1234567');
    expect(box.value).toBe('1.123456');
    expect(posted(container)).toBe('1.123456');
    await mounted.unmount();
  });

  it('keeps the typed rate after the action refuses the form', async () => {
    actions.addFxRateAction.mockResolvedValue({
      status: 'error',
      message: 'That date already has a rate.',
      fields: { currency: 'USD', rateNpr: '133.5', rateDate: TODAY, source: '' },
    });
    const mounted = await mountForm(<FxForm today={TODAY} />);
    const { container } = mounted;
    const box = rateBox(container);
    await typeKeys(box, '133.5');
    await submit(container);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(actions.addFxRateAction).toHaveBeenCalledTimes(1);
    const data = actions.addFxRateAction.mock.calls[0]![1] as FormData;
    expect(data.get('rateNpr')).toBe('133.5');
    expect(container.textContent).toContain('That date already has a rate.');
    expect(box.value).toBe('133.5');
    expect(posted(container)).toBe('133.5');
    await mounted.unmount();
  });
});
