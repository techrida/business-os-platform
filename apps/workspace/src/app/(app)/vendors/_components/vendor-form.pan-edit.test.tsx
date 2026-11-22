// @vitest-environment jsdom
// The PAN box leaves the page while the kind is foreign. A short PAN the person typed must still be
// stopped at submit when the kind comes back; a stored PAN nobody touched must not be.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { choose, mountForm, submit, typeKeys } from '@/test/form-interactions';

import { EMPTY_VENDOR_VALUES, type VendorValues } from '../_lib/forms';
import type { VendorFormState } from '../_lib/state';
import { VendorForm } from './vendor-form';

const action = vi.fn<(prev: VendorFormState, form: FormData) => Promise<VendorFormState>>();

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  action.mockImplementation((prev) => Promise.resolve(prev));
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function mount(initial: VendorValues) {
  mounted = await mountForm(
    <VendorForm
      title="Add vendor"
      action={action}
      mode="create"
      initial={initial}
      idempotencyKey="key-1"
      cancelHref="/vendors"
      reloadHref="/vendors/new"
    />,
  );
  const { container } = mounted;
  const form = container.querySelector('form')!;
  const reached = vi.fn();
  // Bubble phase: the PAN box's capture listener has already run and may have cancelled the submit.
  form.addEventListener('submit', (event) => {
    reached(event.defaultPrevented);
    event.preventDefault();
  });
  const panBox = () =>
    container
      .querySelector('input[name="pan"]')
      ?.parentElement?.querySelector<HTMLInputElement>('input:not([type="hidden"])') ?? null;
  const roundTrip = async () => {
    await choose(container, 'kind', 'Foreign vendor (outside Nepal)');
    // The nine-digit PAN box gives way to the foreign vendor's optional Tax ID.
    expect(container.textContent).toContain('Tax ID (optional)');
    await choose(container, 'kind', 'Company (registered, with a PAN)');
  };
  return { container, reached, panBox, roundTrip };
}

describe('vendor form, PAN edit flag across a kind switch', () => {
  it('still stops a short PAN after the kind is switched to foreign and back', async () => {
    const { container, reached, panBox, roundTrip } = await mount({
      ...EMPTY_VENDOR_VALUES,
      legalName: 'Himal Traders',
    });

    await typeKeys(panBox(), '12345678');
    await roundTrip();
    expect(panBox()!.value).toBe('12345678');

    await submit(container);
    expect(reached).toHaveBeenCalledWith(true);
    expect(action).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(panBox());
    expect(panBox()!.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('A PAN is 9 digits; this has 8.');
  });

  it('does not stop a stored PAN nobody touched, after the same switch', async () => {
    const { reached, panBox, roundTrip, container } = await mount({
      ...EMPTY_VENDOR_VALUES,
      legalName: 'Himal Traders',
      pan: '1234',
    });

    await roundTrip();
    expect(panBox()!.value).toBe('1234');

    await submit(container);
    expect(reached).toHaveBeenCalledWith(false);
  });
});
