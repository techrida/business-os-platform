// @vitest-environment jsdom
import {
  DecimalString,
  NonNegativeDecimalString,
  PercentFourDecimals,
  QuantityString,
  RateString,
} from '@bos/contracts';
import { amountInWords, NO_SPACES, USE_A_POINT } from '@bos/locale';
import { act, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { click, mountForm, paste, submit, typeKeys } from '@/test/form-interactions';
import { Field } from './field';
import { DecimalInput, MoneyInput, PercentInput, QuantityInput } from './number-input';
import { NumberSystemProvider } from './number-system-context';

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
  };
}

async function blur(element: HTMLElement) {
  await act(() => Promise.resolve(element.blur()));
}

describe('live grouping', () => {
  it('groups NPR in lakh style and USD in thousands; the hidden input posts the plain string', async () => {
    const npr = await mount(<MoneyInput aria-label="Amount" name="amount" currency="NPR" />);
    await typeKeys(npr.box, '1250000');
    expect(npr.box.value).toBe('12,50,000');
    expect(npr.hidden()).toBe('1250000');
    await mounted.unmount();

    const usd = await mount(<MoneyInput aria-label="Amount" name="amount" currency="USD" />);
    await typeKeys(usd.box, '1250000');
    expect(usd.box.value).toBe('1,250,000');
    expect(usd.hidden()).toBe('1250000');
  });

  it("follows the tenant's number system for the currency", async () => {
    const { box, hidden } = await mount(
      <NumberSystemProvider value={{ NPR: 'south_asian', INR: 'south_asian', USD: 'south_asian' }}>
        <MoneyInput aria-label="Amount" name="amount" currency="USD" />
      </NumberSystemProvider>,
    );
    await typeKeys(box, '1250000');
    expect(box.value).toBe('12,50,000');
    expect(hidden()).toBe('1250000');
  });

  it('is a text box with the decimal keyboard and no name of its own', async () => {
    const { box } = await mount(<MoneyInput aria-label="Amount" name="amount" currency="NPR" />);
    expect(box.type).toBe('text');
    expect(box.inputMode).toBe('decimal');
    expect(box.autocomplete).toBe('off');
    expect(box.name).toBe('');
    expect(box.getAttribute('role')).toBeNull();
  });
});

describe('refused keystrokes', () => {
  it('refuses a comma and says to use a point', async () => {
    const { box, hidden, status } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await typeKeys(box, '1,');
    expect(box.value).toBe('1');
    expect(status()).toBe(USE_A_POINT);
    await typeKeys(box, '5');
    expect(box.value).toBe('15');
    expect(hidden()).toBe('15');
    expect(status()).toBe('');
  });

  it('refuses a space', async () => {
    const { box, status } = await mount(<MoneyInput aria-label="Amount" currency="NPR" />);
    await typeKeys(box, '10 50');
    expect(box.value).toBe('1,050');
    await typeKeys(box, ' ');
    expect(box.value).toBe('1,050');
    expect(status()).toBe(NO_SPACES);
  });

  it('refuses a third decimal and letters', async () => {
    const { box, hidden, status } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await typeKeys(box, '1.255');
    expect(box.value).toBe('1.25');
    expect(hidden()).toBe('1.25');
    expect(status()).toBe('At most 2 decimals.');
    await typeKeys(box, 'e');
    expect(box.value).toBe('1.25');
    expect(status()).toBe('Use digits and a point only.');
  });

  it('refuses a keystroke past max and names the limit in the tenant grouping', async () => {
    const { box, hidden, status } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" max="2018180" />,
    );
    await typeKeys(box, '20181801');
    expect(box.value).toBe('20,18,180');
    expect(hidden()).toBe('2018180');
    expect(status()).toBe('At most NPR 20,18,180.00');
  });

  it('refuses a point in a whole-number field and uses the numeric keyboard', async () => {
    const { box, status } = await mount(<DecimalInput aria-label="Days" intDigits={3} scale={0} />);
    expect(box.inputMode).toBe('numeric');
    await typeKeys(box, '12.');
    expect(box.value).toBe('12');
    expect(status()).toBe('Whole numbers only.');
    await typeKeys(box, '5');
    expect(box.value).toBe('125');
  });

  it('refuses a keystroke the soft keyboard sends without a key name', async () => {
    const { box, status } = await mount(<MoneyInput aria-label="Amount" currency="NPR" />);
    await typeKeys(box, '1');
    // Android keyboards send keydown "Unidentified"; only beforeinput carries the comma.
    const before = new Event('beforeinput', { bubbles: true, cancelable: true });
    Object.defineProperties(before, { inputType: { value: 'insertText' }, data: { value: ',' } });
    await act(() => Promise.resolve(box.dispatchEvent(before)));
    expect(before.defaultPrevented).toBe(true);
    expect(status()).toBe(USE_A_POINT);
  });
});

describe('caret', () => {
  it('stays right after a typed digit when a separator is inserted', async () => {
    const usd = await mount(<MoneyInput aria-label="Amount" currency="USD" />);
    await typeKeys(usd.box, '1234');
    expect(usd.box.value).toBe('1,234');
    usd.box.setSelectionRange(1, 1);
    await typeKeys(usd.box, '5');
    expect(usd.box.value).toBe('15,234');
    expect(usd.box.selectionStart).toBe(2);
    await mounted.unmount();

    const npr = await mount(<MoneyInput aria-label="Amount" currency="NPR" />);
    await typeKeys(npr.box, '12345');
    expect(npr.box.value).toBe('12,345');
    npr.box.setSelectionRange(2, 2);
    await typeKeys(npr.box, '6');
    expect(npr.box.value).toBe('1,26,345');
    expect(npr.box.selectionStart).toBe(4);
  });

  it('deletes the digit before a separator on Backspace', async () => {
    const { box, hidden } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="USD" />,
    );
    await typeKeys(box, '1234');
    box.setSelectionRange(2, 2);
    await typeKeys(box, '{Backspace}');
    expect(box.value).toBe('234');
    expect(hidden()).toBe('234');
    expect(box.selectionStart).toBe(0);
  });

  it('keeps its place when a middle digit is deleted and regrouping moves a separator', async () => {
    const { box } = await mount(<MoneyInput aria-label="Amount" currency="NPR" />);
    await typeKeys(box, '1250000');
    box.setSelectionRange(4, 4);
    await typeKeys(box, '{Backspace}');
    expect(box.value).toBe('1,20,000');
    expect(box.selectionStart).toBe(3);
  });
});

describe('paste', () => {
  it('refuses 1,5 and keeps the old value', async () => {
    const { box, hidden, status } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await typeKeys(box, '7');
    await paste(box, '1,5');
    expect(box.value).toBe('7');
    expect(hidden()).toBe('7');
    expect(status()).toBe(USE_A_POINT);
  });

  it('accepts a copied amount with its currency code and grouping', async () => {
    const { box, hidden } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await paste(box, 'NPR 12,50,000.00');
    expect(hidden()).toBe('1250000.00');
    expect(box.value).toBe('12,50,000.00');
  });

  it('refuses 10 50', async () => {
    const { box, hidden, status } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await paste(box, '10 50');
    expect(box.value).toBe('');
    expect(hidden()).toBe('');
    expect(status()).toBe(NO_SPACES);
  });

  it('refuses an amount over max', async () => {
    const { box, hidden, status } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" max="2018180" />,
    );
    await paste(box, '2018181');
    expect(hidden()).toBe('');
    expect(status()).toBe('At most NPR 20,18,180.00');
  });

  it('replaces only a selected part, then checks the whole result', async () => {
    const { box, hidden } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await typeKeys(box, '1250000');
    box.setSelectionRange(3, 5);
    await paste(box, '75');
    expect(hidden()).toBe('1275000');
    expect(box.value).toBe('12,75,000');
  });
});

describe('blur', () => {
  it('pads money to two decimals in the box but posts the unpadded value', async () => {
    const { box, hidden } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await typeKeys(box, '1250');
    await blur(box);
    expect(box.value).toBe('1,250.00');
    expect(hidden()).toBe('1250');
  });

  it('drops leading zeros and completes a bare point', async () => {
    const { box, hidden } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await typeKeys(box, '007');
    expect(hidden()).toBe('7');
    await blur(box);
    expect(box.value).toBe('7.00');
    await typeKeys(box, '{Backspace}{Backspace}{Backspace}{Backspace}.5');
    expect(hidden()).toBe('0.5');
  });

  it('checks required and min on blur and marks the box invalid', async () => {
    const { box, status, container } = await mount(
      <MoneyInput aria-label="Amount" currency="NPR" required min="10" />,
    );
    await typeKeys(box, '');
    await blur(box);
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(status()).toBe('Enter a number.');
    expect(container.querySelector('[role="status"]')!.getAttribute('data-tone')).toBe('error');
    await typeKeys(box, '5');
    await blur(box);
    expect(status()).toBe('At least NPR 10.00');
    await typeKeys(box, '{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}12');
    await blur(box);
    expect(box.getAttribute('aria-invalid')).toBeNull();
    expect(status()).toBe('');
  });
});

describe('form reset', () => {
  it('clears the box and the hidden input after a function action', async () => {
    let posted: FormDataEntryValue | null = null;
    mounted = await mountForm(
      <form
        action={(data) => {
          posted = data.get('amount');
        }}
      >
        <MoneyInput aria-label="Amount" name="amount" currency="NPR" />
      </form>,
    );
    const box = mounted.container.querySelector<HTMLInputElement>('input:not([type="hidden"])')!;
    await typeKeys(box, '123');
    await submit(mounted.container);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(posted).toBe('123');
    expect(box.value).toBe('');
    expect(mounted.container.querySelector<HTMLInputElement>('input[name="amount"]')!.value).toBe(
      '',
    );
  });

  it('restores the default value in both inputs', async () => {
    const { box, hidden, container } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" defaultValue="100" />,
    );
    expect(box.value).toBe('100.00');
    expect(hidden()).toBe('100');
    box.setSelectionRange(0, 0);
    await typeKeys(box, '9');
    expect(hidden()).toBe('9100.00');
    await act(() => Promise.resolve(container.querySelector('form')!.reset()));
    expect(box.value).toBe('100.00');
    expect(hidden()).toBe('100');
  });

  it('does not report the reset to a controlled parent', async () => {
    const changes: string[] = [];
    function Parent() {
      const [amount, setAmount] = useState('');
      return (
        <MoneyInput
          aria-label="Amount"
          name="amount"
          currency="NPR"
          value={amount}
          onValueChange={(plain) => {
            changes.push(plain);
            setAmount(plain);
          }}
        />
      );
    }
    const { box, container, hidden } = await mount(<Parent />);
    await typeKeys(box, '42');
    expect(changes).toEqual(['4', '42']);
    await act(() => Promise.resolve(container.querySelector('form')!.reset()));
    expect(changes).toEqual(['4', '42']);
    expect(hidden()).toBe('42');
  });
});

describe('untouched server values', () => {
  it('posts a value outside the field limits as given until the user edits it', async () => {
    const percent = await mount(
      <PercentInput aria-label="Rate" name="rate" scale={2} defaultValue="13.0000" />,
    );
    expect(percent.hidden()).toBe('13.0000');
    await mounted.unmount();
    const days = await mount(
      <DecimalInput aria-label="Days" name="days" intDigits={3} scale={0} defaultValue="5.00" />,
    );
    expect(days.hidden()).toBe('5.00');
  });

  it('posts a valid default without being touched', async () => {
    const { hidden, box } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" defaultValue="1250000.5" />,
    );
    expect(hidden()).toBe('1250000.5');
    expect(box.value).toBe('12,50,000.50');
  });
});

describe('controlled', () => {
  it('keeps a typed point while the parent echoes the plain value', async () => {
    let latest = '';
    function Parent() {
      const [amount, setAmount] = useState('');
      latest = amount;
      return (
        <MoneyInput aria-label="Amount" currency="NPR" value={amount} onValueChange={setAmount} />
      );
    }
    const { box } = await mount(<Parent />);
    await typeKeys(box, '12.');
    expect(box.value).toBe('12.');
    expect(latest).toBe('12');
    await typeKeys(box, '5');
    expect(box.value).toBe('12.5');
    expect(latest).toBe('12.5');
  });
});

describe('accessibility', () => {
  it('describes the box with the prefix, the hint, the error and its own status, in order', async () => {
    const { box, container } = await mount(
      <Field label="Amount" hint="Including VAT" error="Too high">
        {(control) => <MoneyInput {...control} currency="NPR" />}
      </Field>,
    );
    const ids = () => box.getAttribute('aria-describedby')!.split(' ');
    const textOf = (id: string) => container.querySelector(`[id="${id}"]`)?.textContent;
    expect(ids().map(textOf)).toEqual(['NPR', 'Including VAT', 'Too high']);
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.labels?.[0]?.textContent).toBe('Amount');
    await typeKeys(box, ',');
    expect(ids().map(textOf)).toEqual(['NPR', 'Including VAT', 'Too high', USE_A_POINT]);
  });

  it('shows the amount in words, read on focus rather than announced', async () => {
    const { box, container } = await mount(
      <MoneyInput aria-label="Amount" currency="NPR" showWords />,
    );
    expect(box.getAttribute('aria-describedby')).not.toContain('words');
    await typeKeys(box, '2018180');
    const words = amountInWords('2018180', 'NPR', 'south_asian');
    expect(words).toMatch(/lakh/i);
    const line = Array.from(container.querySelectorAll('span')).find(
      (el) => el.textContent === words,
    )!;
    expect(line).toBeDefined();
    expect(line.getAttribute('role')).toBeNull();
    expect(line.getAttribute('aria-live')).toBeNull();
    expect(box.getAttribute('aria-describedby')!.split(' ')).toContain(line.id);
  });
});

describe('QuantityInput', () => {
  it('steps exactly with the buttons and the arrow keys, inside min', async () => {
    const { box, hidden, container } = await mount(
      <QuantityInput aria-label="Quantity" name="qty" step="0.1" defaultValue="0.2" uom="kg" />,
    );
    const increase = container.querySelector<HTMLButtonElement>(
      '[aria-label="Increase quantity"]',
    )!;
    const decrease = container.querySelector<HTMLButtonElement>(
      '[aria-label="Decrease quantity"]',
    )!;
    expect(increase.tabIndex).toBe(-1);
    expect(decrease.tabIndex).toBe(-1);
    await click(increase);
    expect(hidden()).toBe('0.3');
    expect(box.getAttribute('role')).toBe('spinbutton');
    expect(box.getAttribute('aria-valuenow')).toBe('0.3');
    expect(box.getAttribute('aria-valuemin')).toBe('0');
    expect(box.getAttribute('aria-valuetext')).toBe('0.3 kg');
    await typeKeys(box, '{ArrowUp}');
    expect(hidden()).toBe('0.4');
    await typeKeys(box, '{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(hidden()).toBe('0');
    await click(decrease);
    expect(hidden()).toBe('0');
  });

  it('ignores the mouse wheel', async () => {
    const { box, hidden } = await mount(
      <QuantityInput aria-label="Quantity" name="qty" defaultValue="5" />,
    );
    await act(() => Promise.resolve(box.focus()));
    await act(() =>
      Promise.resolve(box.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true }))),
    );
    expect(box.value).toBe('5');
    expect(hidden()).toBe('5');
  });
});

describe('PercentInput', () => {
  it('refuses typing past 100', async () => {
    const { box, hidden, status } = await mount(<PercentInput aria-label="Rate" name="rate" />);
    expect(box.getAttribute('role')).toBe('spinbutton');
    expect(box.getAttribute('aria-valuemax')).toBe('100');
    await typeKeys(box, '100.0001');
    expect(box.value).toBe('100.000');
    expect(status()).toBe('At most 100%');
    await typeKeys(
      box,
      '{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}',
    );
    await typeKeys(box, '101');
    expect(box.value).toBe('10');
    expect(hidden()).toBe('10');
  });
});

describe('emitted values parse with the contract schemas', () => {
  const posted = async (node: ReactNode, keys: string) => {
    const { box, hidden } = await mount(node);
    await typeKeys(box, keys);
    await blur(box);
    const value = hidden();
    await mounted.unmount();
    return value;
  };

  it.each(['1250000', '0.5', '.5', '007', '1.2', '12.', '99999999999999999.999'])(
    'money %s',
    async (keys) => {
      const value = await posted(<MoneyInput aria-label="A" name="v" currency="NPR" />, keys);
      expect(DecimalString.safeParse(value).success).toBe(true);
      expect(NonNegativeDecimalString.safeParse(value).success).toBe(true);
    },
  );

  it.each(['1', '0.0001', '12345678901234.5678', '3.', '999999999999999.99999'])(
    'quantity %s',
    async (keys) => {
      const value = await posted(<QuantityInput aria-label="Q" name="v" />, keys);
      expect(QuantityString.safeParse(value).success).toBe(true);
    },
  );

  it.each(['100', '99.9999', '0', '100.0001', '1000', '12.34567'])('percent %s', async (keys) => {
    const value = await posted(<PercentInput aria-label="P" name="v" />, keys);
    expect(PercentFourDecimals.safeParse(value).success).toBe(true);
  });

  it.each(['133.123456', '1.1234567', '1234567890123.5'])('rate %s', async (keys) => {
    const value = await posted(
      <DecimalInput aria-label="R" name="v" intDigits={12} scale={6} />,
      keys,
    );
    expect(RateString.safeParse(value).success).toBe(true);
  });
});
