// @vitest-environment jsdom
import { useRef, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { click, mountForm, settle } from '@/test/form-interactions';
import { Dialog } from './dialog';

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

const button = (name: string) =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent === name) ?? null;

/** A dialog opened only through `open`, as a form opens its review: there is no Radix trigger. */
function Opened({ onClose }: { onClose: (event: Event) => void }) {
  const [open, setOpen] = useState(true);
  const opener = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button ref={opener} type="button">
        Review
      </button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Check the request"
        onCloseAutoFocus={(event) => {
          onClose(event);
          event.preventDefault();
          opener.current?.focus();
        }}
        footer={
          <button type="button" onClick={() => setOpen(false)}>
            Back
          </button>
        }
      />
    </>
  );
}

it('hands onCloseAutoFocus to the primitive, so a dialog with no trigger can return focus to its opener', async () => {
  const onClose = vi.fn();
  mounted = await mountForm(<Opened onClose={onClose} />);
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await click(button('Back'));
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  // Old code dropped the prop: nothing was called and focus fell to the body.
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(button('Review'));
});

it('still returns focus to its trigger when no onCloseAutoFocus is given', async () => {
  mounted = await mountForm(
    <Dialog
      trigger={<button type="button">Rename</button>}
      title="Rename memo"
      footer={<button type="button">Back</button>}
    />,
  );
  await click(button('Rename'));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await click(document.querySelector('button[aria-label="Close"]'));
  await settle();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.activeElement).toBe(button('Rename'));
});
