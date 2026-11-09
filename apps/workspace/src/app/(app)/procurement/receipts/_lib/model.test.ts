import { describe, expect, it } from 'vitest';

import {
  capText,
  kindsOffered,
  lineCap,
  mayHandleKind,
  receiptActions,
  receiptGrants,
  scaledText,
  signedScaled,
} from './model';

const L = (openQuantity: string, pendingQuantity: string) => ({ openQuantity, pendingQuantity });

describe('lineCap: open minus what drafts reserve', () => {
  it.each([
    ['6.0000', '1.0000', 50000n],
    ['6.0000', '0.0000', 60000n],
    ['2.5000', '0.2500', 22500n],
    ['6.0000', '6.0000', 0n],
    ['6.0000', '7.0000', 0n],
    // An over-receipt exception can leave the open quantity negative: nothing may be received.
    ['-2.0000', '0.0000', 0n],
    ['-2.0000', '1.0000', 0n],
    // A value that does not read as a quantity counts as nothing, not as NaN.
    ['abc', '0.0000', 0n],
  ])('open %s, pending %s gives %s', (open, pending, cap) => {
    expect(lineCap(L(open, pending))).toBe(cap);
  });

  it('shows the cap without trailing zeros', () => {
    expect(capText(L('6.0000', '1.0000'))).toBe('5');
    expect(capText(L('2.5000', '0.2500'))).toBe('2.25');
    expect(capText(L('-2.0000', '0.0000'))).toBe('0');
  });
});

describe('scaled quantities', () => {
  it('round-trips the server text', () => {
    expect(scaledText(50000n)).toBe('5.0000');
    expect(scaledText(1n)).toBe('0.0001');
    expect(scaledText(-22500n)).toBe('-2.2500');
    expect(signedScaled('-2.25')).toBe(-22500n);
    expect(signedScaled('1e3')).toBeNull();
  });
});

describe('who may handle what', () => {
  it('maps default roles to the grants', () => {
    expect(receiptGrants(['warehouse'])).toEqual({ confirm: true, issue: false });
    expect(receiptGrants(['procurement'])).toEqual({ confirm: false, issue: true });
    expect(receiptGrants(['sales'])).toEqual({ confirm: false, issue: false });
  });

  it('offers a service to everyone and goods to the warehouse', () => {
    expect(mayHandleKind('service', { confirm: false })).toBe(true);
    expect(mayHandleKind('goods', { confirm: false })).toBe(false);
    expect(mayHandleKind('goods', { confirm: true })).toBe(true);
  });

  it('offers only kinds with room left that the person may handle', () => {
    const lines = [
      { kind: 'goods' as const, ...L('5.0000', '5.0000') },
      { kind: 'goods' as const, ...L('1.0000', '0.0000') },
      { kind: 'service' as const, ...L('0.0000', '0.0000') },
    ];
    expect(kindsOffered(lines, { confirm: true })).toEqual(['goods']);
    expect(kindsOffered(lines, { confirm: false })).toEqual([]);
    expect(
      kindsOffered([{ kind: 'service' as const, ...L('2.0000', '0.0000') }], { confirm: false }),
    ).toEqual(['service']);
  });
});

describe('receiptActions gating', () => {
  const draft = { status: 'draft' as const, kind: 'goods' as const, reversesReceiptId: null };
  const confirmed = { ...draft, status: 'confirmed' as const };
  const warehouse = { confirm: true };
  const nobody = { confirm: false };

  it('shows Confirm on a draft to the warehouse, and on a service draft to anyone', () => {
    expect(receiptActions(draft, warehouse)).toEqual({ confirm: true, reverse: false });
    expect(receiptActions(draft, nobody)).toEqual({ confirm: false, reverse: false });
    expect(receiptActions({ ...draft, kind: 'service' }, nobody).confirm).toBe(true);
  });

  it('shows Reverse only on a confirmed receipt that is not itself a reversal', () => {
    expect(receiptActions(confirmed, warehouse).reverse).toBe(true);
    expect(receiptActions({ ...confirmed, reversesReceiptId: 'x' }, warehouse).reverse).toBe(false);
    expect(receiptActions({ ...confirmed, status: 'reversed' }, warehouse).reverse).toBe(false);
    expect(receiptActions(draft, warehouse).reverse).toBe(false);
    expect(receiptActions({ ...confirmed, kind: 'service' }, nobody).reverse).toBe(true);
    expect(receiptActions(confirmed, nobody).reverse).toBe(false);
  });

  it('hides both once the order no longer takes them, and leaves it to the API when unknown', () => {
    expect(receiptActions(draft, warehouse, 'closed').confirm).toBe(false);
    expect(receiptActions(draft, warehouse, 'amendment_pending').confirm).toBe(false);
    expect(receiptActions(draft, warehouse, 'partially_received').confirm).toBe(true);
    expect(receiptActions(confirmed, warehouse, 'fully_received').reverse).toBe(true);
    expect(receiptActions(confirmed, warehouse, 'short_closed').reverse).toBe(false);
    expect(receiptActions(confirmed, warehouse, undefined).reverse).toBe(true);
  });
});
