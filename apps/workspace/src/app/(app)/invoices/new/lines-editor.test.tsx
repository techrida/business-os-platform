// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fill, mountForm } from '@/test/form-interactions';

import { TAX } from '../_lib/test-fixtures';

import { LinesEditor, useLines } from './lines-editor';
import { parseLines, parseLinesJson } from './lines';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

/** The editor inside a form that posts `lines` the way the invoice and debit note forms do. */
function Harness() {
  const { lines, setLine, add, remove } = useLines(1);
  return (
    <form>
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />
      <LinesEditor
        lines={lines}
        currency="NPR"
        taxCodes={[{ id: TAX, label: 'VAT 13%' }]}
        errors={{}}
        onChange={setLine}
        onAdd={add}
        onRemove={remove}
      />
    </form>
  );
}

async function mount() {
  mounted = await mountForm(<Harness />);
  const { container } = mounted;
  const box = (label: string): HTMLInputElement => {
    const found = Array.from(container.querySelectorAll('label')).find((l) =>
      l.textContent?.startsWith(label),
    );
    const input = found ? document.getElementById(found.htmlFor) : null;
    if (!(input instanceof HTMLInputElement)) throw new Error(`No box labelled ${label}`);
    return input;
  };
  const posted = () => {
    const raw = new FormData(container.querySelector('form')!).get('lines');
    return parseLinesJson(raw as string)?.[0];
  };
  return { box, posted };
}

async function blur(element: HTMLInputElement) {
  await act(() => Promise.resolve(element.focus()));
  await act(() => Promise.resolve(element.blur()));
}

describe('the line editor', () => {
  it('groups the unit price as it is typed and posts the plain amount', async () => {
    const { box, posted } = await mount();
    const price = box('Unit price (NPR)');
    await fill(price, '1250000');
    expect(price.value).toBe('12,50,000');
    expect(posted()?.unitPrice).toBe('1250000');
  });

  it('takes the quantity in a spin box and flags zero, as the server refuses it', async () => {
    const { box, posted } = await mount();
    const quantity = box('Quantity');
    expect(quantity.getAttribute('role')).toBe('spinbutton');
    await fill(quantity, '0');
    await blur(quantity);
    expect(quantity.getAttribute('aria-invalid')).toBe('true');
    expect(posted()?.quantity).toBe('0');
    const line = {
      ...posted()!,
      description: 'Design',
      uom: 'lot',
      unitPrice: '1',
      taxCodeId: TAX,
    };
    expect(parseLines([line]).ok).toBe(false);
  });

  it('refuses a space inside the price instead of joining the halves', async () => {
    const { box, posted } = await mount();
    const price = box('Unit price (NPR)');
    await fill(price, '10 50');
    expect(price.value).toBe('');
    expect(posted()?.unitPrice).toBe('');
  });
});
