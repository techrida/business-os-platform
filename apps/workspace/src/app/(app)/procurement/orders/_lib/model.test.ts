import { PO_STATUSES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  bandText,
  isReceivable,
  orderActions,
  PO_STATUS_LABEL,
  poGrants,
  poMoney,
  primaryOrderAction,
  qtyText,
} from './model';

describe('primaryOrderAction', () => {
  it('picks the next step: issue, then receive, then enter the bill', () => {
    expect(primaryOrderAction({ issue: true, receive: false, enterBill: false })).toBe('issue');
    expect(primaryOrderAction({ issue: false, receive: true, enterBill: true })).toBe('receive');
    expect(primaryOrderAction({ issue: false, receive: false, enterBill: true })).toBe('enterBill');
    expect(primaryOrderAction({ issue: false, receive: false, enterBill: false })).toBeNull();
  });
});

describe('bandText', () => {
  it('names each approval band in words, and capitalises one it does not know', () => {
    expect(bandText('base')).toBe('Base');
    expect(bandText('management')).toBe('Management');
    expect(bandText('founder')).toBe('Founder');
    expect(bandText('board_level')).toBe('Board level');
    expect(bandText('')).toBe('Not recorded');
  });
});

describe('poGrants', () => {
  it('reads the live grants at any scope, and denies by default', () => {
    expect(poGrants(new Map([['procurement.po.issue', 'all']]))).toEqual({
      issue: true,
      confirm: false,
    });
    expect(poGrants(new Map([['procurement.receipt.confirm', 'own']]))).toEqual({
      issue: false,
      confirm: true,
    });
    expect(poGrants(new Map([['crm.lead.read', 'all']]))).toEqual({ issue: false, confirm: false });
    expect(poGrants(new Map())).toEqual({ issue: false, confirm: false });
  });
});

describe('orderActions', () => {
  const can = { issue: true };
  it('offers issue on a draft only', () => {
    expect(orderActions('draft', can)).toEqual({
      issue: true,
      amend: false,
      shortClose: false,
      cancel: false,
    });
  });
  it('offers amend and cancel on an issued order, amend and short-close once part arrived', () => {
    expect(orderActions('issued', can)).toEqual({
      issue: false,
      amend: true,
      shortClose: false,
      cancel: true,
    });
    expect(orderActions('partially_received', can)).toEqual({
      issue: false,
      amend: true,
      shortClose: true,
      cancel: false,
    });
  });
  it('offers only amend on a fully received order, so more can be received (F1-Q39)', () => {
    expect(orderActions('fully_received', can)).toEqual({
      issue: false,
      amend: true,
      shortClose: false,
      cancel: false,
    });
  });
  it('offers nothing while an amendment waits, or once the order is over', () => {
    for (const s of [
      'amendment_pending',
      'closed',
      'short_closed',
      'cancelled',
    ] as const) {
      expect(Object.values(orderActions(s, can)).some(Boolean)).toBe(false);
    }
  });
  it('offers nothing without the grant', () => {
    for (const s of PO_STATUSES) {
      expect(Object.values(orderActions(s, { issue: false })).some(Boolean)).toBe(false);
    }
  });
});

describe('labels and formatting', () => {
  it('has a label for every status', () => {
    for (const s of PO_STATUSES) expect(PO_STATUS_LABEL[s].text.length).toBeGreaterThan(0);
  });
  it('knows which statuses take a receipt', () => {
    expect(isReceivable('issued')).toBe(true);
    expect(isReceivable('partially_received')).toBe(true);
    expect(isReceivable('amendment_pending')).toBe(false);
    expect(isReceivable('draft')).toBe(false);
  });
  it('trims trailing zeros of a quantity without touching its value', () => {
    expect(qtyText('10.0000')).toBe('10');
    expect(qtyText('2.5000')).toBe('2.5');
    expect(qtyText('0.0500')).toBe('0.05');
    expect(qtyText('-3.0000')).toBe('-3');
    expect(qtyText('abc')).toBe('abc');
  });
  it('formats money from the server in the order currency, lakh grouping', () => {
    expect(poMoney('1234567.00', 'NPR')).toMatch(/12,34,567/);
    expect(poMoney('10.00', 'EUR')).toBe('EUR 10.00');
  });
});
