import type { Permission } from '@bos/contracts';
import { describe, expect, it, vi } from 'vitest';

import { permissionsFrom } from '@/lib/live-permissions';

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

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
vi.mock('@/lib/api', () => ({ getMe: vi.fn() }));

/** The predicate `getPermissionCheck` builds from a `/v1/me` grant list (null: the read failed). */
function live(roles: string[], granted: Permission[] | null): (permission: string) => boolean {
  const held = new Set(
    permissionsFrom(
      granted === null
        ? null
        : { permissions: granted.map((permission) => ({ permission, scope: 'all' as const })) },
      roles,
    ),
  );
  return (permission) => held.has(permission);
}

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
  it('maps live grants to the screen grants', () => {
    // F1-Q52: the warehouse opens the purchase order read-only through its receipt grant.
    expect(receiptGrants(live(['warehouse'], ['procurement.receipt.confirm']))).toEqual({
      confirm: true,
      openOrder: true,
    });
    expect(receiptGrants(live(['procurement'], ['procurement.po.issue']))).toEqual({
      confirm: false,
      openOrder: true,
    });
    expect(receiptGrants(live(['sales'], []))).toEqual({ confirm: false, openOrder: false });
  });

  it('follows saved grants, not role defaults', () => {
    // Sales holds no receipt grant by default; a saved one lets it receive goods.
    expect(receiptGrants(live(['sales'], ['procurement.receipt.confirm'])).confirm).toBe(true);
    // The warehouse holds it by default; a saved role without it takes it away.
    expect(receiptGrants(live(['warehouse'], ['procurement.pr.read'])).confirm).toBe(false);
    expect(mayHandleKind('goods', receiptGrants(live(['warehouse'], [])))).toBe(false);
  });

  it('falls back to role defaults only when /v1/me fails', () => {
    expect(receiptGrants(live(['warehouse'], null))).toEqual({ confirm: true, openOrder: true });
    expect(receiptGrants(live(['sales'], null))).toEqual({ confirm: false, openOrder: false });
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

describe("the receipt's own can flags", () => {
  const draft = { status: 'draft' as const, kind: 'service' as const, reversesReceiptId: null };
  const none = { confirm: false, discard: false, reverse: false };

  it('win over the grant guess: a read-only buyer gets no Confirm or Discard, even on a service', () => {
    // The old guess offered a service draft to anyone; the API's answer for procurement is none.
    expect(receiptActions({ ...draft, can: none }, { confirm: false })).toEqual(none);
    expect(receiptActions({ ...draft, can: none }, { confirm: true }, 'issued')).toEqual(none);
    const mine = { confirm: true, discard: true, reverse: false };
    expect(receiptActions({ ...draft, can: mine }, { confirm: false })).toEqual(mine);
  });

  it('decide which kinds a person can start a receipt for', () => {
    const lines = [
      { kind: 'goods' as const, ...L('2.0000', '0.0000') },
      { kind: 'service' as const, ...L('2.0000', '0.0000') },
    ];
    expect(kindsOffered(lines, { confirm: false }, { goods: false, service: false })).toEqual([]);
    expect(kindsOffered(lines, { confirm: false }, { goods: false, service: true })).toEqual([
      'service',
    ]);
    expect(kindsOffered(lines, { confirm: false })).toEqual(['service']);
  });
});

describe('receiptActions gating', () => {
  const draft = { status: 'draft' as const, kind: 'goods' as const, reversesReceiptId: null };
  const confirmed = { ...draft, status: 'confirmed' as const };
  const warehouse = { confirm: true };
  const nobody = { confirm: false };

  it('shows Confirm on a draft to the warehouse, and on a service draft to anyone', () => {
    expect(receiptActions(draft, warehouse)).toEqual({
      confirm: true,
      discard: true,
      reverse: false,
    });
    expect(receiptActions(draft, nobody)).toEqual({
      confirm: false,
      discard: false,
      reverse: false,
    });
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
