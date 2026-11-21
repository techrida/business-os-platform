// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fill, mountForm, paste, submit, typeKeys } from '@/test/form-interactions';
import { Field } from './field';
import { PanInput } from './pan-input';

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

async function mount(node: ReactNode) {
  mounted = await mountForm(<form>{node}</form>);
  const { container } = mounted;
  return {
    container,
    box: container.querySelector<HTMLInputElement>('input:not([type="hidden"])')!,
    hidden: () => container.querySelector<HTMLInputElement>('input[type="hidden"]')!.value,
    status: () => container.querySelector('[role="status"]')!.textContent,
    count: () => container.querySelector('[id$="-count"]')?.textContent,
  };
}

async function blur(element: HTMLElement) {
  await act(() => Promise.resolve(element.blur()));
}

describe('PanInput', () => {
  it('refuses a letter and says so in the status line', async () => {
    const pan = await mount(<PanInput aria-label="PAN" name="pan" />);
    await typeKeys(pan.box, '123');
    await typeKeys(pan.box, 'A');
    expect(pan.box.value).toBe('123');
    expect(pan.hidden()).toBe('123');
    expect(pan.status()).toBe('A PAN takes digits only.');
  });

  it('refuses a tenth digit and keeps the nine', async () => {
    const pan = await mount(<PanInput aria-label="PAN" name="pan" />);
    await typeKeys(pan.box, '1234567890');
    expect(pan.box.value).toBe('123456789');
    expect(pan.hidden()).toBe('123456789');
    expect(pan.status()).toBe('A PAN is exactly 9 digits.');
  });

  it('shows a live count and clears the refusal on the next good key', async () => {
    const pan = await mount(<PanInput aria-label="PAN" name="pan" />);
    expect(pan.count()).toBe('0 of 9');
    await typeKeys(pan.box, '1234567');
    expect(pan.count()).toBe('7 of 9');
    await typeKeys(pan.box, 'x');
    expect(pan.status()).not.toBe('');
    await typeKeys(pan.box, '8');
    expect(pan.status()).toBe('');
    expect(pan.count()).toBe('8 of 9');
  });

  it('is a numeric-keypad text box, not a number input', async () => {
    const pan = await mount(<PanInput aria-label="PAN" name="pan" />);
    expect(pan.box.type).toBe('text');
    expect(pan.box.getAttribute('inputmode')).toBe('numeric');
    // No pattern attribute: it would make the browser refuse to submit a stored legacy value untouched.
    expect(pan.box.hasAttribute('pattern')).toBe(false);
    expect(pan.box.hasAttribute('name')).toBe(false);
  });

  it('strips spaces and dashes from a paste', async () => {
    const pan = await mount(<PanInput aria-label="PAN" name="pan" />);
    await paste(pan.box, '123-456 789');
    expect(pan.box.value).toBe('123456789');
    expect(pan.hidden()).toBe('123456789');
    expect(pan.status()).toBe('');
  });

  it('refuses a paste with letters or more than nine digits, and keeps what was there', async () => {
    const pan = await mount(<PanInput aria-label="PAN" name="pan" defaultValue="12" />);
    await paste(pan.box, 'AB1234567');
    expect(pan.box.value).toBe('12');
    expect(pan.status()).toBe('A PAN takes digits only.');
    await paste(pan.box, '1234567890');
    expect(pan.box.value).toBe('12');
    expect(pan.status()).toBe('A PAN is exactly 9 digits.');
  });

  it('refuses text that arrives whole (autofill, a drop) when it is not nine digits or fewer', async () => {
    const pan = await mount(<PanInput aria-label="PAN" name="pan" />);
    await typeKeys(pan.box, '12');
    await fill(pan.box, '12ab');
    expect(pan.box.value).toBe('12');
    expect(pan.status()).toBe('A PAN takes digits only.');
  });

  it('flags a short PAN on blur and clears the flag once it is nine digits', async () => {
    const pan = await mount(<PanInput aria-label="PAN" name="pan" />);
    await typeKeys(pan.box, '1234567');
    await blur(pan.box);
    expect(pan.status()).toBe('A PAN is 9 digits; this has 7.');
    expect(pan.box.getAttribute('aria-invalid')).toBe('true');
    await typeKeys(pan.box, '89');
    expect(pan.status()).toBe('');
    expect(pan.box.getAttribute('aria-invalid')).toBeNull();
  });

  it('shows a stored value exactly as stored, so an unrelated edit never rewrites it', async () => {
    const dashed = await mount(<PanInput aria-label="PAN" name="pan" defaultValue="123-456-789" />);
    expect(dashed.box.value).toBe('123-456-789');
    expect(dashed.hidden()).toBe('123-456-789');
    expect(dashed.box.getAttribute('aria-invalid')).toBe('true');
    // Submitting without touching it is allowed: the form's other edits must still save.
    const submitted = vi.fn((event: Event) => event.preventDefault());
    dashed.container.querySelector('form')!.addEventListener('submit', submitted);
    await submit(dashed.container);
    expect(submitted).toHaveBeenCalledTimes(1);
    await mounted.unmount();

    const bad = await mount(<PanInput aria-label="PAN" name="pan" defaultValue="12345678901" />);
    expect(bad.box.value).toBe('12345678901');
    expect(bad.hidden()).toBe('12345678901');
    expect(bad.box.getAttribute('aria-invalid')).toBe('true');
    // The stored value can be repaired by deleting.
    await typeKeys(bad.box, '{Backspace}{Backspace}');
    expect(bad.box.value).toBe('123456789');
    expect(bad.box.getAttribute('aria-invalid')).toBeNull();
  });

  it('stops a submit of a PAN the user typed but left short, and puts focus on the box', async () => {
    const pan = await mount(<PanInput aria-label="PAN" name="pan" />);
    const reached = vi.fn();
    pan.container.querySelector('form')!.addEventListener('submit', (event) => {
      reached(event.defaultPrevented);
      event.preventDefault();
    });
    await typeKeys(pan.box, '12345678');
    await submit(pan.container);
    // The box's capture listener cancelled the submit before the page's own listener saw it.
    expect(reached).toHaveBeenCalledWith(true);
    expect(pan.status()).toBe('A PAN is 9 digits; this has 8.');
    expect(document.activeElement).toBe(pan.box);
    await typeKeys(pan.box, '9');
    await submit(pan.container);
    expect(reached).toHaveBeenLastCalledWith(false);
  });

  it('posts through a form and names the box with its Field label', async () => {
    const pan = await mount(
      <Field label="PAN" error="Required.">
        {(control) => <PanInput {...control} name="pan" required />}
      </Field>,
    );
    expect(pan.container.querySelector('label')!.getAttribute('for')).toBe(pan.box.id);
    expect(pan.box.required).toBe(true);
    await typeKeys(pan.box, '601234567');
    const data = new FormData(pan.container.querySelector('form')!);
    expect(data.get('pan')).toBe('601234567');
    await submit(pan.container);
  });

  it('describes the box with its count, and the status line is a live region', async () => {
    const pan = await mount(<PanInput aria-label="PAN" name="pan" />);
    const countId = pan.container.querySelector('[id$="-count"]')!.id;
    expect(pan.box.getAttribute('aria-describedby')).toContain(countId);
    expect(pan.container.querySelector('[role="status"]')).not.toBeNull();
  });

  it('follows a controlled parent and reports changes as the posted string', async () => {
    const seen: string[] = [];
    function Harness() {
      const [pan, setPan] = useState('12');
      return (
        <>
          <PanInput
            aria-label="PAN"
            name="pan"
            value={pan}
            onValueChange={(next) => {
              seen.push(next);
              setPan(next);
            }}
          />
          <button type="button" onClick={() => setPan('987654321')}>
            Fill
          </button>
        </>
      );
    }
    const pan = await mount(<Harness />);
    await typeKeys(pan.box, '3');
    expect(seen).toEqual(['123']);
    await act(() =>
      Promise.resolve(
        pan.container
          .querySelector('button')!
          .dispatchEvent(new MouseEvent('click', { bubbles: true })),
      ),
    );
    expect(pan.box.value).toBe('987654321');
    expect(pan.hidden()).toBe('987654321');
  });

  it('restores its default on a form reset', async () => {
    const pan = await mount(<PanInput aria-label="PAN" name="pan" defaultValue="111111111" />);
    await typeKeys(pan.box, '{Backspace}{Backspace}');
    expect(pan.box.value).toBe('1111111');
    await act(() => Promise.resolve(pan.container.querySelector('form')!.reset()));
    expect(pan.box.value).toBe('111111111');
    expect(pan.hidden()).toBe('111111111');
  });
});
