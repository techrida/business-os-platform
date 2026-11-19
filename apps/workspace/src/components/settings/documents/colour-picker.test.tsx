// @vitest-environment jsdom
import { useState } from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm } from '../../../test/form-interactions';
import { hexToHsv, hsvToHex } from './colour-math';
import { ColourPicker } from './colour-picker';

// React reads this flag to allow act() outside a test renderer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const HEX = /^#[0-9a-f]{6}$/;

function Harness({ start, onChange }: { start: string; onChange: (hex: string) => void }) {
  const [value, setValue] = useState(start);
  return (
    <>
      <ColourPicker
        value={value}
        onChange={(hex) => {
          onChange(hex);
          setValue(hex);
        }}
      />
      <button type="button" data-testid="external" onClick={() => setValue('#00ff00')}>
        external
      </button>
    </>
  );
}

let mounted: Awaited<ReturnType<typeof mountForm>> | null = null;
let onChange: ReturnType<typeof vi.fn<(hex: string) => void>>;

async function render(start: string) {
  mounted = await mountForm(<Harness start={start} onChange={onChange} />);
  return mounted.container;
}

beforeEach(() => {
  onChange = vi.fn<(hex: string) => void>();
});

afterEach(async () => {
  await mounted?.unmount();
  mounted = null;
});

const area = (c: HTMLElement) => c.querySelector<HTMLElement>('[role="slider"]')!;
const hueSlider = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[type="range"]')!;
const hexInput = (c: HTMLElement) => c.querySelector<HTMLInputElement>('input[type="text"]')!;
const lastHex = () => onChange.mock.calls.at(-1)?.[0];

async function press(element: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  await act(() => {
    element.dispatchEvent(event);
    return Promise.resolve();
  });
  return event;
}

async function blur(element: HTMLElement) {
  await act(() => {
    element.focus();
    element.blur();
    return Promise.resolve();
  });
}

async function pointer(element: HTMLElement, type: string, x: number, y: number) {
  await act(() => {
    element.dispatchEvent(
      new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }),
    );
    return Promise.resolve();
  });
}

function sizeBox(element: HTMLElement, width: number, height: number) {
  element.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 }) as DOMRect;
}

describe('ColourPicker area', () => {
  it('describes the position as a slider with a plain-words value', async () => {
    const c = await render('#cc3333');
    const slider = area(c);
    expect(slider.getAttribute('aria-valuetext')).toBe('Saturation 75%, brightness 80%');
    expect(slider.getAttribute('aria-label')).toBe('Saturation and brightness');
    expect(slider.tabIndex).toBe(0);
  });

  it('moves saturation with left and right and brightness with up and down', async () => {
    const c = await render('#cc3333');
    const slider = area(c);
    await press(slider, 'ArrowRight');
    expect(slider.getAttribute('aria-valuetext')).toBe('Saturation 76%, brightness 80%');
    expect(lastHex()).toBe(hsvToHex({ h: 0, s: 0.76, v: 0.8 }));
    await press(slider, 'ArrowUp');
    expect(slider.getAttribute('aria-valuetext')).toBe('Saturation 76%, brightness 81%');
    await press(slider, 'ArrowLeft');
    await press(slider, 'ArrowDown');
    expect(slider.getAttribute('aria-valuetext')).toBe('Saturation 75%, brightness 80%');
  });

  it('moves ten steps with Shift and stops at the edges', async () => {
    const c = await render('#cc3333');
    const slider = area(c);
    await press(slider, 'ArrowRight', { shiftKey: true });
    await press(slider, 'ArrowUp', { shiftKey: true });
    expect(slider.getAttribute('aria-valuetext')).toBe('Saturation 85%, brightness 90%');
    await press(slider, 'ArrowRight', { shiftKey: true });
    await press(slider, 'ArrowRight', { shiftKey: true });
    expect(slider.getAttribute('aria-valuetext')).toBe('Saturation 100%, brightness 90%');
    const calls = onChange.mock.calls.length;
    await press(slider, 'ArrowRight');
    expect(onChange).toHaveBeenCalledTimes(calls);
  });

  it('keeps default behaviour for other keys and for modified arrows', async () => {
    const c = await render('#cc3333');
    const slider = area(c);
    expect((await press(slider, 'Tab')).defaultPrevented).toBe(false);
    expect((await press(slider, 'ArrowRight', { ctrlKey: true })).defaultPrevented).toBe(false);
    expect((await press(slider, 'ArrowRight')).defaultPrevented).toBe(true);
  });

  it('follows a pointer drag and stops when the pointer is released', async () => {
    const c = await render('#cc3333');
    const slider = area(c);
    sizeBox(slider, 200, 100);
    await pointer(slider, 'pointerdown', 100, 50);
    expect(lastHex()).toBe(hsvToHex({ h: 0, s: 0.5, v: 0.5 }));
    await pointer(slider, 'pointermove', 200, 0);
    expect(lastHex()).toBe('#ff0000');
    await pointer(slider, 'pointermove', 400, -50);
    expect(slider.getAttribute('aria-valuetext')).toBe('Saturation 100%, brightness 100%');
    await pointer(slider, 'pointerup', 0, 100);
    const calls = onChange.mock.calls.length;
    await pointer(slider, 'pointermove', 0, 100);
    expect(onChange).toHaveBeenCalledTimes(calls);
  });

  it('ignores moves before a press and a zero-size box', async () => {
    const c = await render('#cc3333');
    const slider = area(c);
    sizeBox(slider, 200, 100);
    await pointer(slider, 'pointermove', 100, 50);
    expect(onChange).not.toHaveBeenCalled();
    sizeBox(slider, 0, 0);
    await pointer(slider, 'pointerdown', 10, 10);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('opts out of browser touch scrolling so a finger drag moves the thumb', async () => {
    // jsdom does not load the CSS module, so the guard lives in the stylesheet.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const css = readFileSync(join(__dirname, 'colour-picker.module.css'), 'utf8');
    expect(css).toMatch(/\.area\s*\{[^}]*touch-action:\s*none/);
  });
});

describe('ColourPicker hue slider', () => {
  it('is a native range from 0 to 360 showing the current hue', async () => {
    const c = await render('#00ff00');
    const slider = hueSlider(c);
    expect(slider.min).toBe('0');
    expect(slider.max).toBe('360');
    expect(slider.value).toBe('120');
    expect(slider.getAttribute('aria-label')).toBe('Hue');
  });

  it('changes the colour on input and keeps saturation and brightness', async () => {
    const c = await render('#cc3333');
    await fill(hueSlider(c), '120');
    expect(lastHex()).toBe(hsvToHex({ h: 120, s: 0.75, v: 0.8 }));
    expect(area(c).getAttribute('aria-valuetext')).toBe('Saturation 75%, brightness 80%');
    await fill(hueSlider(c), '360');
    expect(lastHex()).toBe(hsvToHex({ h: 0, s: 0.75, v: 0.8 }));
  });

  it('remembers the hue when the colour goes grey, then uses it again', async () => {
    const c = await render('#3366cc');
    const hue = Math.round(hexToHsv('#3366cc')!.h);
    await fill(hexInput(c), '#808080');
    await blur(hexInput(c));
    expect(lastHex()).toBe('#808080');
    expect(hueSlider(c).value).toBe(String(hue));
    await press(area(c), 'ArrowRight');
    expect(lastHex()).toBe(hsvToHex({ h: hue, s: 0.01, v: hexToHsv('#808080')!.v }));
  });
});

describe('ColourPicker hex input', () => {
  it('shows the current colour and a swatch', async () => {
    const c = await render('#1D4ED8');
    expect(hexInput(c).value).toBe('#1d4ed8');
    expect(
      c.querySelector<HTMLElement>('[aria-hidden="true"][class*="swatch"]')!.style.background,
    ).not.toBe('');
  });

  it('commits a typed colour on blur, with or without the hash', async () => {
    const c = await render('#cc3333');
    await fill(hexInput(c), '1D4ED8');
    expect(onChange).not.toHaveBeenCalled();
    await blur(hexInput(c));
    expect(onChange).toHaveBeenCalledExactlyOnceWith('#1d4ed8');
    expect(hexInput(c).value).toBe('#1d4ed8');
  });

  it('commits on Enter, expands shorthand and does not submit a surrounding form', async () => {
    const c = await render('#cc3333');
    await fill(hexInput(c), 'abc');
    const event = await press(hexInput(c), 'Enter');
    expect(event.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith('#aabbcc');
    expect(hexInput(c).value).toBe('#aabbcc');
  });

  it('keeps invalid text, flags it inline and never calls onChange', async () => {
    const c = await render('#cc3333');
    await fill(hexInput(c), '#12zz45');
    expect(c.querySelector('[role="alert"]')).toBeNull();
    await blur(hexInput(c));
    expect(onChange).not.toHaveBeenCalled();
    expect(hexInput(c).value).toBe('#12zz45');
    expect(hexInput(c).getAttribute('aria-invalid')).toBe('true');
    const alert = c.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('hex colour');
    expect(hexInput(c).getAttribute('aria-describedby')).toBe(alert.id);
    await press(hexInput(c), 'Enter');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('clears the error once the text is valid and treats empty text as invalid', async () => {
    const c = await render('#cc3333');
    await fill(hexInput(c), '');
    await blur(hexInput(c));
    expect(hexInput(c).getAttribute('aria-invalid')).toBe('true');
    expect(onChange).not.toHaveBeenCalled();
    await fill(hexInput(c), '#fff');
    expect(hexInput(c).getAttribute('aria-invalid')).toBe('false');
    expect(c.querySelector('[role="alert"]')).toBeNull();
  });

  it('reverts to the current colour on Escape', async () => {
    const c = await render('#cc3333');
    await fill(hexInput(c), 'nope');
    await blur(hexInput(c));
    await press(hexInput(c), 'Escape');
    expect(hexInput(c).value).toBe('#cc3333');
    expect(hexInput(c).getAttribute('aria-invalid')).toBe('false');
  });

  it('drops an unfinished draft when the colour is changed elsewhere', async () => {
    const c = await render('#cc3333');
    await fill(hexInput(c), '#12');
    await press(area(c), 'ArrowRight');
    expect(hexInput(c).value).toBe(lastHex());
  });

  it('does not call onChange when the typed colour is the current one', async () => {
    const c = await render('#cc3333');
    await fill(hexInput(c), 'CC3333');
    await blur(hexInput(c));
    expect(onChange).not.toHaveBeenCalled();
    expect(hexInput(c).value).toBe('#cc3333');
  });
});

describe('ColourPicker value prop', () => {
  it('follows a colour the parent sets', async () => {
    const c = await render('#cc3333');
    await click(c.ownerDocument.querySelector('[data-testid="external"]'));
    expect(hexInput(c).value).toBe('#00ff00');
    expect(hueSlider(c).value).toBe('120');
    expect(area(c).getAttribute('aria-valuetext')).toBe('Saturation 100%, brightness 100%');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('renders an unparseable value as black instead of crashing', async () => {
    const c = await render('not a colour');
    expect(hexInput(c).value).toBe('#000000');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('ColourPicker onChange', () => {
  it('only ever receives lowercase #rrggbb across mixed input', async () => {
    const c = await render('#cc3333');
    for (const text of [
      '',
      '#',
      'zz',
      '#12',
      '#12345',
      '#1234567',
      'rgb(1,2,3)',
      '#ABC',
      'ff8800',
      ' #00F ',
    ]) {
      await fill(hexInput(c), text);
      await blur(hexInput(c));
    }
    await press(area(c), 'ArrowLeft', { shiftKey: true });
    await press(area(c), 'ArrowDown', { shiftKey: true });
    await fill(hueSlider(c), '359');
    await fill(hueSlider(c), '0');
    sizeBox(area(c), 100, 100);
    await pointer(area(c), 'pointerdown', -50, 500);
    await pointer(area(c), 'pointermove', 500, -500);
    await pointer(area(c), 'pointerup', 0, 0);
    expect(onChange.mock.calls.length).toBeGreaterThan(5);
    for (const [hex] of onChange.mock.calls) expect(hex).toMatch(HEX);
  });
});
