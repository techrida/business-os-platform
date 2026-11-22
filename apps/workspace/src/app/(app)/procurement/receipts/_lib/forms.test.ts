import { ConfirmReceiptBodySchema, decimalPattern, QUANTITY_LIMITS } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { EMPTY_LINE, parseReceipt, splitSerials, type CapLine, type ReceiptValues } from './forms';

const PO = '11111111-1111-4111-8111-111111111111';
const SERIAL = '22222222-2222-4222-8222-222222222221';
const PLAIN = '22222222-2222-4222-8222-222222222222';
const SERVICE = '22222222-2222-4222-8222-222222222223';

const lines: CapLine[] = [
  {
    poLineId: SERIAL,
    lineNo: 1,
    kind: 'goods',
    uom: 'pcs',
    requiresSerials: true,
    openQuantity: '6.0000',
    pendingQuantity: '1.0000', // cap 5
  },
  {
    poLineId: PLAIN,
    lineNo: 2,
    kind: 'goods',
    uom: 'kg',
    requiresSerials: false,
    openQuantity: '10.0000',
    pendingQuantity: '0.0000',
  },
  {
    poLineId: SERVICE,
    lineNo: 3,
    kind: 'service',
    uom: 'visit',
    requiresSerials: false,
    openQuantity: '3.0000',
    pendingQuantity: '0.0000',
  },
];

function values(
  over: Partial<ReceiptValues> = {},
  line: Record<string, object> = {},
): ReceiptValues {
  const mk = (id: string) => ({ ...EMPTY_LINE, ...(line[id] ?? {}) });
  return {
    kind: 'goods',
    receivedAt: '2026-11-09',
    location: '',
    lines: { [SERIAL]: mk(SERIAL), [PLAIN]: mk(PLAIN), [SERVICE]: mk(SERVICE) },
    ...over,
  };
}
const fail = (v: ReceiptValues) => {
  const r = parseReceipt(PO, v, lines);
  if (r.ok) throw new Error('expected a refusal');
  return r.errors;
};

describe('the receipt body', () => {
  it('sends only the lines with a quantity, in the shape the API accepts', () => {
    const r = parseReceipt(
      PO,
      values(
        { location: ' Kathmandu store ' },
        {
          [SERIAL]: { quantity: '2', serials: 'SN-1\n SN-2 \n\n' },
          [PLAIN]: { quantity: '2.5', note: ' one box wet ', inspection: 'ok' },
        },
      ),
      lines,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body).toEqual({
      purchaseOrderId: PO,
      kind: 'goods',
      receivedAt: '2026-11-09',
      location: 'Kathmandu store',
      lines: [
        { poLineId: SERIAL, quantity: '2', serials: [{ serialNo: 'SN-1' }, { serialNo: 'SN-2' }] },
        { poLineId: PLAIN, quantity: '2.5', inspection: 'ok', discrepancyNote: 'one box wet' },
      ],
    });
    expect(ConfirmReceiptBodySchema.safeParse(r.body).success).toBe(true);
  });

  it('takes one kind per receipt: lines of the other kind are left out', () => {
    const r = parseReceipt(
      PO,
      values({ kind: 'service' }, { [SERVICE]: { quantity: '1' }, [PLAIN]: { quantity: '99' } }),
      lines,
    );
    expect(r.ok && r.body.lines.map((l) => l.poLineId)).toEqual([SERVICE]);
  });

  it('refuses an empty receipt, an unknown kind and a bad date', () => {
    expect(fail(values())['lines']).toMatch(/at least one line/);
    expect(fail(values({ kind: 'both' }))['kind']).toBeDefined();
    expect(
      fail(values({ receivedAt: '2026-02-30' }, { [PLAIN]: { quantity: '1' } }))['receivedAt'],
    ).toBeDefined();
    expect(
      fail(values({ receivedAt: '09/11/2026' }, { [PLAIN]: { quantity: '1' } }))['receivedAt'],
    ).toBeDefined();
  });
});

describe('the quantity cap (open minus pending in drafts)', () => {
  it('accepts exactly the cap and refuses a hair above it', () => {
    const ok = parseReceipt(
      PO,
      values({}, { [SERIAL]: { quantity: '5', serials: 'a\nb\nc\nd\ne' } }),
      lines,
    );
    expect(ok.ok).toBe(true);
    const errors = fail(values({}, { [SERIAL]: { quantity: '6', serials: 'a\nb\nc\nd\ne\nf' } }));
    expect(errors[`${SERIAL}.quantity`]).toMatch(/Only 5 pcs/);
    expect(fail(values({}, { [PLAIN]: { quantity: '10.0001' } }))[`${PLAIN}.quantity`]).toMatch(
      /Only 10 kg/,
    );
  });

  it('refuses a line with nothing left, including a negative open quantity', () => {
    const full: CapLine[] = [
      { ...lines[1]!, openQuantity: '2.0000', pendingQuantity: '2.0000' },
      { ...lines[0]!, openQuantity: '-1.0000', pendingQuantity: '0.0000' },
    ];
    for (const l of full) {
      const r = parseReceipt(
        PO,
        values({}, { [l.poLineId]: { quantity: '1', serials: 'a' } }),
        full,
      );
      expect(!r.ok && r.errors[`${l.poLineId}.quantity`]).toMatch(/Nothing is left/);
    }
  });

  it('refuses zero, text, a fifth decimal and more than 14 digits', () => {
    for (const q of ['0', '0.0000', 'abc', '1.00001', '-1', '1e3', '123456789012345']) {
      expect(fail(values({}, { [PLAIN]: { quantity: q } }))[`${PLAIN}.quantity`]).toBeDefined();
    }
  });
});

describe('the quantity shape follows the contract limits', () => {
  const big: CapLine[] = [
    { ...lines[1]!, openQuantity: '99999999999999.9999', pendingQuantity: '0.0000' },
  ];
  const quantityError = (quantity: string) => {
    const r = parseReceipt(PO, values({}, { [PLAIN]: { quantity } }), big);
    return r.ok ? null : (r.errors[`${PLAIN}.quantity`] ?? null);
  };

  it('accepts 14 whole digits and 4 decimals, the most QUANTITY_LIMITS allows', () => {
    expect(QUANTITY_LIMITS).toEqual({ intDigits: 14, scale: 4 });
    for (const q of ['99999999999999.9999', '12345678901234', '0.0001', '1250000']) {
      expect(decimalPattern(QUANTITY_LIMITS).test(q)).toBe(true);
      expect(quantityError(q)).toBeNull();
    }
  });

  it('refuses a 15th whole digit or a 5th decimal, as the contract does', () => {
    for (const q of ['123456789012345', '1.00001', '1,5', '10,50', '.5']) {
      expect(decimalPattern(QUANTITY_LIMITS).test(q)).toBe(false);
      expect(quantityError(q)).toMatch(/up to 4 decimal places/);
    }
  });

  it('sends the same body for grouped or zero-padded text as for the plain number', () => {
    // A form posted before hydration carries the typed text; a hydrated number box posts the plain number.
    const body = (quantity: string) => {
      const r = parseReceipt(PO, values({}, { [PLAIN]: { quantity } }), big);
      if (!r.ok) throw new Error(`refused ${quantity}: ${JSON.stringify(r.errors)}`);
      return r.body;
    };
    for (const [typed, plain] of [
      ['1,500.00', '1500'],
      ['10.50', '10.5'],
      ['12,50,000.00', '1250000'],
    ] as const) {
      expect(body(typed)).toEqual(body(plain));
      expect(body(typed).lines).toEqual([{ poLineId: PLAIN, quantity: plain }]);
    }
  });

  it('caps grouped text by its value: 10.0000 fits a 10 kg line, 1,000 does not', () => {
    const r = parseReceipt(PO, values({}, { [PLAIN]: { quantity: '10.0000' } }), lines);
    expect(r.ok && r.body.lines).toEqual([{ poLineId: PLAIN, quantity: '10' }]);
    expect(fail(values({}, { [PLAIN]: { quantity: '1,000' } }))[`${PLAIN}.quantity`]).toMatch(
      /Only 10 kg/,
    );
  });

  it('says to remove a space inside the number', () => {
    expect(quantityError('10 50')).toMatch(/Remove the space/);
    expect(quantityError('1 250 000')).toMatch(/Remove the space/);
    expect(quantityError(' 1050 ')).toBeNull();
  });
});

describe('serial numbers', () => {
  const serialLine = (quantity: string, serials: string) =>
    fail(values({}, { [SERIAL]: { quantity, serials } }));

  it('wants whole units, and as many serial numbers as units', () => {
    expect(serialLine('1.5', 'a\nb')[`${SERIAL}.quantity`]).toMatch(/whole units/);
    expect(serialLine('3', 'a\nb')[`${SERIAL}.serials`]).toMatch(
      /Enter 3 serial numbers.*entered 2/,
    );
    expect(serialLine('1', 'a\nb')[`${SERIAL}.serials`]).toMatch(/Enter 1 serial number,/);
    expect(serialLine('2', '')[`${SERIAL}.serials`]).toBeDefined();
  });

  it('wants every serial number different, and at most 100 characters', () => {
    expect(serialLine('2', 'a\na')[`${SERIAL}.serials`]).toMatch(/"a" is there twice/);
    expect(serialLine('1', 'x'.repeat(101))[`${SERIAL}.serials`]).toMatch(/100/);
  });

  it('refuses serial numbers on a line that does not take them, or without a quantity', () => {
    expect(
      fail(values({}, { [PLAIN]: { quantity: '1', serials: 'a' } }))[`${PLAIN}.serials`],
    ).toMatch(/does not take/);
    expect(fail(values({}, { [SERIAL]: { serials: 'a' } }))[`${SERIAL}.quantity`]).toBeDefined();
  });

  it('refuses more units than the API takes serial numbers for (1000)', () => {
    const big: CapLine[] = [{ ...lines[0]!, openQuantity: '5000.0000', pendingQuantity: '0.0000' }];
    const r = parseReceipt(
      PO,
      values(
        {},
        {
          [SERIAL]: {
            quantity: '1001',
            serials: Array.from({ length: 1001 }, (_, i) => `s${i}`).join('\n'),
          },
        },
      ),
      big,
    );
    expect(!r.ok && r.errors[`${SERIAL}.quantity`]).toMatch(/at most 1000/);
  });

  it('splits on any line ending and drops blanks', () => {
    expect(splitSerials('a\r\n b \n\n\nc')).toEqual(['a', 'b', 'c']);
  });
});
