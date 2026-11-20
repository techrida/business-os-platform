// Table tests of the pure receipt rules (P4 unit P4r): what a draft may take in, the serial counts, the status a PO
// derives from what was received, the reversal lines and the progress rows.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/receipts/receipt.rules.test.ts
import { describe, expect, it } from 'vitest';

import {
  CreateReceiptBodySchema,
  derivePoStatus,
  progressRowsOf,
  reversalLinesOf,
  serialViolation,
  validateDraftLines,
  type PoLineFacts,
} from './receipt.rules';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const poLine = (n: number, over: Partial<PoLineFacts> = {}): PoLineFacts => ({
  id: id(n),
  lineNo: n,
  kind: 'goods',
  description: `Line ${n}`,
  uom: 'pcs',
  orderedQuantity: '5.0000',
  cancelledQuantity: '0.0000',
  requiresSerials: false,
  ...over,
});

const facts = (...lines: PoLineFacts[]) => new Map(lines.map((l) => [l.id, l]));
const net = (entries: Record<string, string> = {}) => new Map(Object.entries(entries));
const line = (n: number, quantity: string, over: Record<string, unknown> = {}) => ({
  poLineId: id(n),
  quantity,
  ...over,
});

describe('CreateReceiptBodySchema', () => {
  const base = { purchaseOrderId: id(100), kind: 'goods', receivedAt: '2026-11-09' };

  it('takes no over-receipt exception id at all (F1-Q39: amend the order first)', () => {
    expect(CreateReceiptBodySchema.safeParse({ ...base, lines: [line(1, '3')] }).success).toBe(
      true,
    );
    for (const exception of [null, id(9)]) {
      const parsed = CreateReceiptBodySchema.safeParse({
        ...base,
        lines: [line(1, '3', { overReceiptExceptionId: exception })],
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('keeps the body strict: a status or a number is the server', () => {
    const parsed = CreateReceiptBodySchema.safeParse({
      ...base,
      status: 'confirmed',
      lines: [line(1, '3')],
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a zero or negative quantity: a return is a reversal', () => {
    for (const quantity of ['0', '-1', '0.0000']) {
      expect(
        CreateReceiptBodySchema.safeParse({ ...base, lines: [line(1, quantity)] }).success,
      ).toBe(false);
    }
  });
});

describe('validateDraftLines', () => {
  it('passes a quantity up to what is open', () => {
    expect(validateDraftLines('goods', [line(1, '5')], facts(poLine(1)), net())).toBeNull();
    expect(
      validateDraftLines('goods', [line(1, '2')], facts(poLine(1)), net({ [id(1)]: '3.0000' })),
    ).toBeNull();
  });

  it('refuses 6 against 5 with over_receipt', () => {
    expect(validateDraftLines('goods', [line(1, '6')], facts(poLine(1)), net())?.code).toBe(
      'over_receipt',
    );
  });

  it('tells the receiver to ask Procurement to amend the order first (F1-Q39)', () => {
    const v = validateDraftLines('goods', [line(1, '6')], facts(poLine(1)), net());
    expect(v?.message).toBe(
      'Line 1 has only 5 still open on the purchase order. To receive more, ask Procurement to amend the purchase order first.',
    );
  });

  it('counts what other receipts, drafts included, already took, and the cancelled quantity', () => {
    const f = facts(poLine(1, { cancelledQuantity: '1.0000' }));
    expect(validateDraftLines('goods', [line(1, '1')], f, net({ [id(1)]: '3.0000' }))).toBeNull();
    expect(validateDraftLines('goods', [line(1, '3')], f, net({ [id(1)]: '2.0000' }))?.code).toBe(
      'over_receipt',
    );
  });

  it('refuses a line of another PO, a repeated line and a kind mismatch', () => {
    expect(validateDraftLines('goods', [line(2, '1')], facts(poLine(1)), net())?.code).toBe(
      'po_line_unknown',
    );
    expect(
      validateDraftLines('goods', [line(1, '1'), line(1, '2')], facts(poLine(1)), net())?.code,
    ).toBe('duplicate_po_line');
    expect(validateDraftLines('service', [line(1, '1')], facts(poLine(1)), net())?.code).toBe(
      'receipt_kind_mismatch',
    );
  });

  describe('serials', () => {
    const serial = (s: string) => ({ serialNo: s });
    const f = facts(poLine(1, { requiresSerials: true }));

    it('needs as many serials as units, and whole units', () => {
      expect(
        validateDraftLines(
          'goods',
          [line(1, '2', { serials: [serial('A'), serial('B')] })],
          f,
          net(),
        ),
      ).toBeNull();
      expect(validateDraftLines('goods', [line(1, '2')], f, net())?.code).toBe('serials_required');
      expect(
        validateDraftLines('goods', [line(1, '2', { serials: [serial('A')] })], f, net())?.code,
      ).toBe('serials_required');
      expect(
        validateDraftLines('goods', [line(1, '1.5', { serials: [serial('A')] })], f, net())?.code,
      ).toBe('serials_required');
    });

    it('refuses the same serial twice on one line', () => {
      expect(
        validateDraftLines(
          'goods',
          [line(1, '2', { serials: [serial('A'), serial('A')] })],
          f,
          net(),
        )?.code,
      ).toBe('serial_duplicate');
    });

    it('refuses serials on a line that does not take them', () => {
      expect(
        validateDraftLines(
          'goods',
          [line(1, '1', { serials: [serial('A')] })],
          facts(poLine(1)),
          net(),
        )?.code,
      ).toBe('serials_not_allowed');
    });
  });
});

describe('serialViolation (the recheck at confirm)', () => {
  it('compares the stored serial count with the quantity', () => {
    expect(serialViolation(true, '3.0000', 3)).toBeNull();
    expect(serialViolation(true, '3.0000', 2)?.code).toBe('serials_required');
    expect(serialViolation(false, '3.0000', 0)).toBeNull();
  });
});

describe('derivePoStatus', () => {
  const row = (ordered: string, cancelled: string, received: string) => ({
    orderedQuantity: ordered,
    cancelledQuantity: cancelled,
    receivedQuantity: received,
  });

  it('is issued while nothing is confirmed', () => {
    expect(derivePoStatus([row('5', '0', '0'), row('2', '0', '0')])).toBe('issued');
  });
  it('is partially_received once anything is, and fully_received when every line is covered', () => {
    expect(derivePoStatus([row('5', '0', '3'), row('2', '0', '0')])).toBe('partially_received');
    expect(derivePoStatus([row('5', '0', '5'), row('2', '0', '1')])).toBe('partially_received');
    expect(derivePoStatus([row('5', '0', '5'), row('2', '0', '2')])).toBe('fully_received');
  });
  it('counts a cancelled quantity as covered', () => {
    expect(derivePoStatus([row('5', '2', '3'), row('2', '2', '0')])).toBe('fully_received');
  });
  it('goes back down after a reversal nets a line to zero', () => {
    expect(derivePoStatus([row('5', '0', '0.0000')])).toBe('issued');
  });
});

describe('reversalLinesOf', () => {
  it('negates every line and names the line it reverses', () => {
    const rows = reversalLinesOf([
      { id: id(11), lineNo: 1, poLineId: id(1), quantity: '5.0000' },
      { id: id(12), lineNo: 2, poLineId: id(2), quantity: '0.2500' },
    ]);
    expect(rows).toEqual([
      { lineNo: 1, poLineId: id(1), quantity: '-5.0000', reversesReceiptLineId: id(11) },
      { lineNo: 2, poLineId: id(2), quantity: '-0.2500', reversesReceiptLineId: id(12) },
    ]);
  });
});

describe('progressRowsOf', () => {
  it('shows ordered, received, still open and billed (zero until bills exist) per line', () => {
    const rows = progressRowsOf(
      [poLine(1), poLine(2, { kind: 'service', orderedQuantity: '1.0000' })],
      new Map([
        [id(1), { net: '5.0000', confirmed: '3.0000', draft: '2.0000' }],
        [id(2), { net: '0.0000', confirmed: '0.0000', draft: '0.0000' }],
      ]),
    );
    expect(rows[0]).toMatchObject({
      poLineId: id(1),
      orderedQuantity: '5.0000',
      cancelledQuantity: '0.0000',
      receivedQuantity: '3.0000',
      pendingQuantity: '2.0000',
      openQuantity: '2.0000',
      billedQuantity: '0.0000',
    });
    expect(rows[1]).toMatchObject({ receivedQuantity: '0.0000', openQuantity: '1.0000' });
  });
});
