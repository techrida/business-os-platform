// @vitest-environment jsdom
import {
  DecimalString,
  NonNegativeDecimalString,
  PercentFourDecimals,
  QuantityString,
  RateString,
} from '@bos/contracts';
import { amountInWords, NO_SPACES, USE_A_POINT } from '@bos/locale';
import { Dec } from '@bos/locale';
import { act, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  click,
  drop,
  fill,
  mountForm,
  paste,
  softKey,
  submit,
  typeKeys,
} from '@/test/form-interactions';
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
    await typeKeys(usd.box, '1234', { settleEach: true });
    expect(usd.box.value).toBe('1,234');
    usd.box.setSelectionRange(1, 1);
    await typeKeys(usd.box, '5', { settleEach: true });
    expect(usd.box.value).toBe('15,234');
    expect(usd.box.selectionStart).toBe(2);
    await mounted.unmount();

    const npr = await mount(<MoneyInput aria-label="Amount" currency="NPR" />);
    await typeKeys(npr.box, '12345', { settleEach: true });
    expect(npr.box.value).toBe('12,345');
    npr.box.setSelectionRange(2, 2);
    await typeKeys(npr.box, '6', { settleEach: true });
    expect(npr.box.value).toBe('1,26,345');
    expect(npr.box.selectionStart).toBe(4);
  });

  it('deletes the digit before a separator on Backspace', async () => {
    const { box, hidden } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="USD" />,
    );
    await typeKeys(box, '1234', { settleEach: true });
    box.setSelectionRange(2, 2);
    await typeKeys(box, '{Backspace}', { settleEach: true });
    expect(box.value).toBe('234');
    expect(hidden()).toBe('234');
    expect(box.selectionStart).toBe(0);
  });

  it('keeps its place when a middle digit is deleted and regrouping moves a separator', async () => {
    const { box } = await mount(<MoneyInput aria-label="Amount" currency="NPR" />);
    await typeKeys(box, '1250000', { settleEach: true });
    box.setSelectionRange(4, 4);
    await typeKeys(box, '{Backspace}', { settleEach: true });
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
  it('pads money to two decimals in the box and posts what the box shows', async () => {
    const changes: string[] = [];
    const { box, hidden } = await mount(
      <MoneyInput
        aria-label="Amount"
        name="amount"
        currency="NPR"
        onValueChange={(plain) => changes.push(plain)}
      />,
    );
    await typeKeys(box, '1250');
    await blur(box);
    expect(box.value).toBe('1,250.00');
    expect(hidden()).toBe('1250.00');
    expect(changes.at(-1)).toBe('1250.00');
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
    expect(hidden()).toBe('100.00');
    box.setSelectionRange(0, 0);
    await typeKeys(box, '9');
    expect(box.value).toBe('9,100.00');
    expect(hidden()).toBe('9100.00');
    await act(() => Promise.resolve(container.querySelector('form')!.reset()));
    expect(box.value).toBe('100.00');
    expect(hidden()).toBe('100.00');
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
    expect(box.value).toBe('42.00');
    expect(hidden()).toBe('42.00');
  });
});

describe('untouched server values', () => {
  it('posts a value outside the field limits as given until the user edits it', async () => {
    const percent = await mount(
      <PercentInput aria-label="Rate" name="rate" scale={2} defaultValue="13.0000" />,
    );
    expect(percent.hidden()).toBe('13.00');
    await mounted.unmount();
    const days = await mount(
      <DecimalInput aria-label="Days" name="days" intDigits={3} scale={0} defaultValue="5.00" />,
    );
    expect(days.hidden()).toBe('5');
  });

  it('posts a valid default without being touched', async () => {
    const { hidden, box } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" defaultValue="1250000.5" />,
    );
    expect(hidden()).toBe('1250000.50');
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
  it('describes the box with the hint, the prefix, the error and its own status, in order', async () => {
    const { box, container } = await mount(
      <Field label="Amount" hint="Including VAT" error="Too high">
        {(control) => <MoneyInput {...control} currency="NPR" />}
      </Field>,
    );
    const ids = () => box.getAttribute('aria-describedby')!.split(' ');
    const textOf = (id: string) => container.querySelector(`[id="${id}"]`)?.textContent;
    expect(ids().map(textOf)).toEqual(['Including VAT', 'NPR', 'Too high']);
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.labels?.[0]?.textContent).toBe('Amount');
    await typeKeys(box, ',');
    expect(ids().map(textOf)).toEqual(['Including VAT', 'NPR', 'Too high', USE_A_POINT]);
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

describe('emitted values equal the expected string and parse with the contract schemas', () => {
  const posted = async (node: ReactNode, keys: string) => {
    const { box, hidden } = await mount(node);
    await typeKeys(box, keys);
    await blur(box);
    const value = hidden();
    const invalid = box.getAttribute('aria-invalid') === 'true';
    expect(value).toBe(box.value.replaceAll(',', ''));
    await mounted.unmount();
    return { value, invalid };
  };

  it.each([
    ['1250000', '1250000.00'],
    ['0.5', '0.50'],
    ['.5', '0.50'],
    ['007', '7.00'],
    ['1.2', '1.20'],
    ['12.', '12.00'],
    ['99999999999999999.999', '9999999999999999.99'],
  ])('money %s posts %s', async (keys, expected) => {
    const { value } = await posted(<MoneyInput aria-label="A" name="v" currency="NPR" />, keys);
    expect(value).toBe(expected);
    expect(DecimalString.safeParse(value).success).toBe(true);
    expect(NonNegativeDecimalString.safeParse(value).success).toBe(true);
  });

  it.each([
    ['1', '1'],
    ['0.0001', '0.0001'],
    ['12345678901234.5678', '12345678901234.5678'],
    ['3.', '3'],
    ['999999999999999.99999', '99999999999999.9999'],
  ])('quantity %s posts %s', async (keys, expected) => {
    const { value } = await posted(<QuantityInput aria-label="Q" name="v" />, keys);
    expect(value).toBe(expected);
    expect(QuantityString.safeParse(value).success).toBe(true);
  });

  it('quantity 0 posts 0 and is marked invalid, because QuantityString needs more than zero', async () => {
    const { value, invalid } = await posted(<QuantityInput aria-label="Q" name="v" />, '0');
    expect(value).toBe('0');
    expect(invalid).toBe(true);
    expect(QuantityString.safeParse(value).success).toBe(false);
  });

  it.each([
    ['100', '100'],
    ['99.9999', '99.9999'],
    ['0', '0'],
    ['100.0001', '100.000'],
    ['1000', '100'],
    ['12.34567', '12.3456'],
  ])('percent %s posts %s', async (keys, expected) => {
    const { value } = await posted(<PercentInput aria-label="P" name="v" />, keys);
    expect(value).toBe(expected);
    expect(PercentFourDecimals.safeParse(value).success).toBe(true);
  });

  it.each([
    ['133.123456', '133.123456'],
    ['1.1234567', '1.123456'],
    ['1234567890123.5', '123456789012.5'],
  ])('rate %s posts %s', async (keys, expected) => {
    const { value } = await posted(
      <DecimalInput aria-label="R" name="v" intDigits={12} scale={6} />,
      keys,
    );
    expect(value).toBe(expected);
    expect(RateString.safeParse(value).success).toBe(true);
  });
});

describe('review fixes', () => {
  it.each(['1,5', '10 50', '1.2.3', '10,50'])(
    'refuses %s arriving without keydown or beforeinput (autofill)',
    async (text) => {
      const { box, hidden, status } = await mount(
        <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
      );
      await fill(box, text);
      expect(box.value).toBe('');
      expect(hidden()).toBe('');
      expect(status()).not.toBe('');
    },
  );

  it('refuses a comma inserted into a value without keydown, keeping the old value', async () => {
    const { box, hidden, status } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await typeKeys(box, '15');
    await fill(box, '1,5');
    expect(box.value).toBe('15');
    expect(hidden()).toBe('15');
    expect(status()).toBe(USE_A_POINT);
  });

  it('accepts validly grouped autofill and keeps separators the formatter inserts', async () => {
    const { box, hidden } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await fill(box, '12,50,000');
    expect(hidden()).toBe('1250000');
    expect(box.value).toBe('12,50,000');
  });

  it('routes dropped text through the paste rules', async () => {
    const { box, hidden, status } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await drop(box, '1,5');
    expect(hidden()).toBe('');
    expect(status()).toBe(USE_A_POINT);
    await drop(box, 'NPR 12,50,000.00');
    expect(hidden()).toBe('1250000.00');
  });

  it('keeps a typed point when a controlled parent canonicalises with Dec', async () => {
    function Parent() {
      const [amount, setAmount] = useState('');
      return (
        <MoneyInput
          aria-label="Amount"
          name="amount"
          currency="NPR"
          value={amount}
          onValueChange={(plain) => setAmount(plain === '' ? '' : new Dec(plain).toString())}
        />
      );
    }
    const { box, hidden } = await mount(<Parent />);
    await typeKeys(box, '1.05');
    expect(box.value).toBe('1.05');
    expect(hidden()).toBe('1.05');
  });

  it('keeps a server value with extra zero decimals through focus and blur', async () => {
    const { box, hidden } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" defaultValue="13.0000" />,
    );
    expect(box.value).toBe('13.00');
    expect(hidden()).toBe('13.00');
    await act(() => Promise.resolve(box.focus()));
    await blur(box);
    expect(hidden()).toBe('13.00');
  });

  it('steps from the posted value, not from zero', async () => {
    const { box, hidden } = await mount(
      <PercentInput aria-label="Rate" name="rate" scale={2} defaultValue="12.5000" />,
    );
    expect(hidden()).toBe('12.50');
    await typeKeys(box, '{ArrowUp}');
    expect(hidden()).toBe('13.5');
  });

  it('never wipes an out-of-limit server value on blur; it shows the error instead', async () => {
    const { box, hidden, status } = await mount(
      <PercentInput aria-label="Rate" name="rate" scale={2} defaultValue="12.5555" />,
    );
    await act(() => Promise.resolve(box.focus()));
    await blur(box);
    expect(hidden()).toBe('12.5555');
    expect(box.value).toBe('12.5555');
    expect(status()).toBe('At most 2 decimals.');
    expect(box.getAttribute('aria-invalid')).toBe('true');
  });

  it('refuses a step past the digit limit and disables the buttons at the bounds', async () => {
    const changes: string[] = [];
    const { box, hidden, status, container } = await mount(
      <QuantityInput
        aria-label="Quantity"
        name="qty"
        defaultValue="99999999999999"
        onValueChange={(plain) => changes.push(plain)}
      />,
    );
    await typeKeys(box, '{ArrowUp}');
    expect(hidden()).toBe('99999999999999');
    expect(box.value).toBe('9,99,99,99,99,99,999');
    expect(status()).toBe('At most 14 digits before the point.');
    expect(changes).toEqual([]);
    await mounted.unmount();

    const atMin = await mount(<QuantityInput aria-label="Quantity" name="qty" defaultValue="0" />);
    const button = (label: string) =>
      atMin.container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
    expect(button('Decrease quantity').disabled).toBe(true);
    expect(button('Increase quantity').disabled).toBe(false);
    await mounted.unmount();
    const atMax = await mount(
      <QuantityInput aria-label="Quantity" name="qty" defaultValue="5" max="5" />,
    );
    expect(
      atMax.container.querySelector<HTMLButtonElement>('[aria-label="Increase quantity"]')!
        .disabled,
    ).toBe(true);
    void container;
  });

  it('inserts a paste at a collapsed caret and checks the whole result', async () => {
    const { box, hidden, status } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await typeKeys(box, '1500');
    box.setSelectionRange(1, 1);
    await paste(box, '9');
    expect(hidden()).toBe('19500');
    expect(box.value).toBe('19,500');
    // The caret follows the pasted text, so the next key lands after it.
    await typeKeys(box, '7');
    expect(hidden()).toBe('197500');
    box.setSelectionRange(box.value.length, box.value.length);
    await paste(box, '.255');
    expect(hidden()).toBe('197500');
    expect(status()).toBe('At most 2 decimals.');
  });

  it('deletes the digit before a separator on an Android Backspace (no key name)', async () => {
    const { box, hidden } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="USD" />,
    );
    await typeKeys(box, '1250');
    expect(box.value).toBe('1,250');
    box.setSelectionRange(2, 2);
    await softKey(box, 'deleteContentBackward');
    expect(hidden()).toBe('250');
    box.setSelectionRange(0, 0);
    await typeKeys(box, '4');
    box.setSelectionRange(1, 1);
    await softKey(box, 'deleteContentForward');
    expect(hidden()).toBe('450');
  });

  it('announces a repeated refusal again', async () => {
    const { box, container } = await mount(<MoneyInput aria-label="Amount" currency="NPR" />);
    const region = container.querySelector('[role="status"]')!;
    await typeKeys(box, '1,');
    let changes = 0;
    const observer = new MutationObserver((records) => {
      changes += records.length;
    });
    observer.observe(region, { childList: true, subtree: true, characterData: true });
    await typeKeys(box, ',');
    changes += observer.takeRecords().length;
    expect(changes).toBeGreaterThan(0);
    observer.disconnect();
    expect(region.textContent).toBe(USE_A_POINT);
  });

  it('shows a refusal over a standing blur error, and keeps the error until the value is valid', async () => {
    const { box, status, container } = await mount(
      <MoneyInput aria-label="Amount" currency="NPR" required min="10" />,
    );
    await act(() => Promise.resolve(box.focus()));
    await blur(box);
    expect(status()).toBe('Enter a number.');
    // "Enter a number." no longer describes 5, and a min error is not shown mid-typing.
    await typeKeys(box, '5');
    expect(status()).toBe('');
    await blur(box);
    expect(status()).toBe('At least NPR 10.00');
    await typeKeys(box, ',');
    expect(status()).toBe(USE_A_POINT);
    expect(container.querySelector('[role="status"]')!.getAttribute('data-tone')).toBeNull();
    // Blur padded the box to 5.00; the 0 goes before the point.
    box.setSelectionRange(1, 1);
    await typeKeys(box, '0');
    expect(box.value).toBe('50.00');
    expect(status()).toBe('');
    expect(box.getAttribute('aria-invalid')).toBeNull();
  });

  it('gives assistive technology the grouped value with its unit, and the unit when empty', async () => {
    const { box, container } = await mount(<QuantityInput aria-label="Quantity" uom="kg" />);
    const described = () =>
      box
        .getAttribute('aria-describedby')!
        .split(' ')
        .map((id) => container.querySelector(`[id="${id}"]`)?.textContent);
    expect(described()).toContain('kg');
    await typeKeys(box, '12345.');
    expect(box.getAttribute('aria-valuetext')).toBe('12,345 kg');
    await typeKeys(box, '{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}{Backspace}');
    await typeKeys(box, '12345678901234.5678');
    expect(box.getAttribute('aria-valuenow')).toBeNull();
    expect(box.getAttribute('aria-valuetext')).toBe('1,23,45,67,89,01,234.5678 kg');
  });

  it('posts what the box shows after a paste into a padded display', async () => {
    const { box, hidden } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" defaultValue="100" />,
    );
    expect(box.value).toBe('100.00');
    await act(() => Promise.resolve(box.focus()));
    box.setSelectionRange(0, 0);
    await paste(box, '9');
    expect(box.value).toBe('9,100.00');
    expect(hidden()).toBe('9100.00');
  });

  it('still replaces the value when everything is selected', async () => {
    const { box, hidden } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await typeKeys(box, '1500');
    box.setSelectionRange(0, box.value.length);
    await paste(box, 'NPR 12,50,000.00');
    expect(hidden()).toBe('1250000.00');
  });

  it('reads the words after the hint and prefix and before the error', async () => {
    const { box, container } = await mount(
      <Field label="Amount" hint="Including VAT" error="Too high">
        {(control) => <MoneyInput {...control} currency="NPR" showWords />}
      </Field>,
    );
    await typeKeys(box, '2018180');
    const order = box
      .getAttribute('aria-describedby')!
      .split(' ')
      .map((id) => container.querySelector(`[id="${id}"]`)?.textContent);
    expect(order).toEqual([
      'Including VAT',
      'NPR',
      amountInWords('2018180', 'NPR', 'south_asian'),
      'Too high',
    ]);
  });

  it('focuses the input when the prefix is pressed', async () => {
    const { box, container } = await mount(<MoneyInput aria-label="Amount" currency="NPR" />);
    const prefix = Array.from(container.querySelectorAll('span')).find(
      (el) => el.textContent === 'NPR',
    )!;
    await act(() =>
      Promise.resolve(prefix.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))),
    );
    expect(document.activeElement).toBe(box);
  });
});

describe('the box and the hidden input hold one value', () => {
  const ungrouped = (box: HTMLInputElement) => box.value.replaceAll(',', '');

  it('keeps both on the parent value when a controlled parent refuses an edit, and after a reset', async () => {
    function Parent() {
      const [days] = useState('10');
      return <DecimalInput aria-label="Days" name="days" intDigits={5} scale={0} value={days} />;
    }
    const { box, hidden, container } = await mount(<Parent />);
    await typeKeys(box, '9');
    expect(box.value).toBe('10');
    expect(hidden()).toBe('10');
    await act(() => Promise.resolve(container.querySelector('form')!.reset()));
    expect(box.value).toBe('10');
    expect(hidden()).toBe('10');
  });

  it('refuses 1,5 delivered by an input event over a selected value', async () => {
    const { box, hidden, status } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" defaultValue="1234" />,
    );
    expect(box.value).toBe('1,234.00');
    await act(() => Promise.resolve(box.focus()));
    box.setSelectionRange(0, box.value.length);
    await fill(box, '1,5');
    expect(box.value).toBe('1,234.00');
    expect(hidden()).toBe('1234.00');
    expect(status()).toBe(USE_A_POINT);
  });

  it('refuses Rs. 12 delivered by an input event into an empty box', async () => {
    const { box, hidden, status } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await fill(box, 'Rs. 12');
    expect(box.value).toBe('');
    expect(hidden()).toBe('');
    expect(status()).not.toBe('');
  });

  it('shows a value the field cannot hold as sent, marks it invalid and posts exactly that', async () => {
    const { box, hidden, status } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" defaultValue="-1250.50" />,
    );
    expect(box.value).toBe('-1250.50');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(status()).not.toBe('');
    expect(hidden()).toBe('-1250.50');
  });

  it('posts what is shown after typing in front of a padded default', async () => {
    const half = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" defaultValue=".5" />,
    );
    expect(half.box.value).toBe('0.50');
    await act(() => Promise.resolve(half.box.focus()));
    half.box.setSelectionRange(0, 0);
    await typeKeys(half.box, '9');
    expect(half.box.value).toBe('90.50');
    expect(half.hidden()).toBe('90.50');
    await mounted.unmount();

    const zeros = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" defaultValue="012.3" />,
    );
    expect(zeros.box.value).toBe('12.30');
    await act(() => Promise.resolve(zeros.box.focus()));
    zeros.box.setSelectionRange(0, 0);
    await typeKeys(zeros.box, '9');
    expect(zeros.box.value).toBe('912.30');
    expect(zeros.hidden()).toBe(ungrouped(zeros.box));
  });

  it('posts what is shown after the point of a padded value is deleted', async () => {
    const { box, hidden } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" defaultValue="100" />,
    );
    await act(() => Promise.resolve(box.focus()));
    box.setSelectionRange(4, 4);
    await typeKeys(box, '{Backspace}');
    expect(box.value).toBe('10,000');
    expect(hidden()).toBe(ungrouped(box));
  });
});

describe('paste, validity, stepping and stale errors', () => {
  it('ignores an empty clipboard and keeps the selected digits', async () => {
    const { box, hidden } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await typeKeys(box, '1500');
    box.setSelectionRange(1, 3);
    await paste(box, '');
    expect(box.value).toBe('1,500');
    expect(hidden()).toBe('1500');
  });

  it('puts the caret after a pasted digit so the next key follows it', async () => {
    const { box, hidden } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await typeKeys(box, '1234');
    await paste(box, '9');
    await typeKeys(box, '8');
    expect(hidden()).toBe('123498');
    expect(box.value).toBe('1,23,498');
  });

  it('marks a required box holding only a point invalid, natively too', async () => {
    const { box } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" required />,
    );
    await typeKeys(box, '.');
    expect(box.value).toBe('.');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(box.validity.valid).toBe(false);
    await typeKeys(box, '5');
    expect(box.validity.valid).toBe(true);
  });

  it.each(['0', '0.0000'])('says a quantity of %s must be above zero', async (keys) => {
    const { box, status } = await mount(<QuantityInput aria-label="Quantity" name="qty" />);
    await typeKeys(box, keys);
    await blur(box);
    expect(status()).toBe('Must be above zero.');
    expect(box.getAttribute('aria-invalid')).toBe('true');
  });

  it('rounds a step to the scale before comparing it with max', async () => {
    const { box, hidden, status } = await mount(
      <PercentInput aria-label="Rate" name="rate" defaultValue="99.9999" max="99.99995" />,
    );
    await typeKeys(box, '{ArrowUp}');
    expect(hidden()).toBe('99.9999');
    expect(status()).toBe('At most 99.99995%');
  });

  it('replaces an error that no longer describes the value and clears it once valid', async () => {
    const { box, status } = await mount(
      <PercentInput aria-label="Rate" name="rate" scale={2} defaultValue="12.5555" />,
    );
    expect(status()).toBe('At most 2 decimals.');
    await act(() => Promise.resolve(box.focus()));
    box.setSelectionRange(box.value.length, box.value.length);
    await typeKeys(box, '{Backspace}');
    expect(status()).toBe('At most 2 decimals.');
    await typeKeys(box, '{Backspace}');
    expect(box.value).toBe('12.55');
    expect(status()).toBe('');
    expect(box.getAttribute('aria-invalid')).toBeNull();
  });
});

describe('edges of the one-value rule', () => {
  it('refuses a comma from a composition insert that cannot be cancelled', async () => {
    const { box, hidden, status } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" />,
    );
    await typeKeys(box, '1');
    const before = new Event('beforeinput', { bubbles: true, cancelable: false });
    Object.defineProperties(before, {
      inputType: { value: 'insertCompositionText' },
      data: { value: ',5' },
    });
    await act(() => Promise.resolve(box.dispatchEvent(before)));
    await fill(box, '1,5');
    expect(box.value).toBe('1');
    expect(hidden()).toBe('1');
    expect(status()).toBe(USE_A_POINT);
  });

  it('works from the parent value after a controlled parent refuses an edit', async () => {
    const changes: string[] = [];
    const { box, hidden } = await mount(
      <QuantityInput
        aria-label="Quantity"
        name="qty"
        value="10"
        onValueChange={(plain) => changes.push(plain)}
      />,
    );
    await typeKeys(box, '9');
    await typeKeys(box, '9');
    expect(changes).toEqual(['109', '109']);
    expect(box.value).toBe('10');
    await typeKeys(box, '{ArrowUp}');
    expect(changes.at(-1)).toBe('11');
    expect(hidden()).toBe('10');
  });

  it.each([
    ['-5', '-5'],
    ['.', '.'],
    ['12.', '12.00'],
    ['1,000', '1,000'],
  ])('settles on controlled value %s and shows %s', async (given, shown) => {
    const { box, hidden } = await mount(
      <MoneyInput aria-label="Amount" name="amount" currency="NPR" value={given} />,
    );
    expect(box.value).toBe(shown);
    expect(hidden()).toBe(shown.replaceAll(',', '').replace(/\.$/, ''));
  });
});
