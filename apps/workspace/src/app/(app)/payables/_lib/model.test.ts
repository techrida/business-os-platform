import {
  BILL_STATUSES,
  DEFAULT_ROLE_PERMISSIONS,
  MATCH_STATUSES,
  type AccessScope,
  type Permission,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  BILL_STATUS_LABEL,
  MATCH_STATUS_LABEL,
  billActions,
  billGrants,
  fileStatusLabel,
  matchResultLabel,
} from './model';

describe('labels', () => {
  it('has words for every bill status and match status the contracts know', () => {
    for (const s of BILL_STATUSES) expect(BILL_STATUS_LABEL[s].text).not.toBe('');
    for (const s of MATCH_STATUSES) expect(MATCH_STATUS_LABEL[s].text).not.toBe('');
  });

  it('shows a line match status it has not met as plain words instead of failing', () => {
    expect(matchResultLabel('matched').tone).toBe('success');
    expect(matchResultLabel('variance').tone).toBe('warning');
    expect(matchResultLabel('tolerated').text).toBe('tolerated');
  });

  it('words a file scan status, and says so when there is none', () => {
    expect(fileStatusLabel('clean').tone).toBe('success');
    expect(fileStatusLabel('infected').tone).toBe('error');
    expect(fileStatusLabel('scan_failed').text).toBe('Scan failed');
    expect(fileStatusLabel('rejected').text).toBe('File rejected');
    expect(fileStatusLabel('scanning').tone).toBe('info');
    expect(fileStatusLabel(null).text).toBe('Unscanned');
  });
});

describe('grants', () => {
  // A stand-in for the live saved grants GET /v1/me reports (`getGrants`).
  const live = (g: Partial<Record<Permission, string>>): Map<Permission, AccessScope> =>
    new Map(Object.entries(g) as [Permission, AccessScope][]);

  it('follows a live grant the role lacks by default: Procurement given bill entry', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.procurement['payables.bill.enter']).toBeUndefined();
    const g = live({ ...DEFAULT_ROLE_PERMISSIONS.procurement, 'payables.bill.enter': 'all' });
    expect(billGrants(g)).toEqual({ enter: true, read: false });
  });

  it('follows a removed grant the role holds by default: an accountant without bill entry', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.accountant['payables.bill.enter']).toBe('all');
    const g = live(DEFAULT_ROLE_PERMISSIONS.accountant);
    g.delete('payables.bill.enter');
    expect(billGrants(g)).toEqual({ enter: false, read: true });
  });

  it('allows nothing when there are no live grants (a failed read), whatever the roles', () => {
    expect(billGrants(live({}))).toEqual({ enter: false, read: false });
  });

  it('counts a grant at any scope', () => {
    expect(billGrants(live({ 'payables.bill.read': 'own' }))).toEqual({ enter: false, read: true });
  });
});

describe('billActions', () => {
  const can = { enter: true };
  const po = 'po-1';

  it('offers nothing without the grant', () => {
    expect(
      billActions(
        { status: 'draft', matchStatus: 'not_required', purchaseOrderId: null },
        { enter: false },
      ),
    ).toEqual({ match: false, submit: false, void: false });
  });

  it('submits a non-PO draft and a matched PO bill, never one in variance or with a pending exception', () => {
    expect(
      billActions({ status: 'draft', matchStatus: 'not_required', purchaseOrderId: null }, can)
        .submit,
    ).toBe(true);
    expect(
      billActions({ status: 'matching', matchStatus: 'matched', purchaseOrderId: po }, can).submit,
    ).toBe(true);
    expect(
      billActions(
        { status: 'exception_pending', matchStatus: 'exception_approved', purchaseOrderId: po },
        can,
      ).submit,
    ).toBe(true);
    expect(
      billActions({ status: 'variance', matchStatus: 'variance', purchaseOrderId: po }, can).submit,
    ).toBe(false);
    expect(
      billActions({ status: 'draft', matchStatus: 'pending', purchaseOrderId: po }, can).submit,
    ).toBe(false);
    expect(
      billActions({ status: 'pending_approval', matchStatus: 'matched', purchaseOrderId: po }, can)
        .submit,
    ).toBe(false);
  });

  it('re-runs the match only for a PO bill that is still being matched', () => {
    expect(
      billActions({ status: 'variance', matchStatus: 'variance', purchaseOrderId: po }, can).match,
    ).toBe(true);
    expect(
      billActions({ status: 'draft', matchStatus: 'pending', purchaseOrderId: po }, can).match,
    ).toBe(true);
    expect(
      billActions({ status: 'variance', matchStatus: 'variance', purchaseOrderId: null }, can)
        .match,
    ).toBe(false);
    expect(
      billActions({ status: 'approved', matchStatus: 'matched', purchaseOrderId: po }, can).match,
    ).toBe(false);
  });

  it('voids only an approved bill', () => {
    expect(
      billActions({ status: 'approved', matchStatus: 'matched', purchaseOrderId: po }, can).void,
    ).toBe(true);
    expect(
      billActions({ status: 'partially_paid', matchStatus: 'matched', purchaseOrderId: po }, can)
        .void,
    ).toBe(false);
    expect(
      billActions({ status: 'voided', matchStatus: 'matched', purchaseOrderId: po }, can).void,
    ).toBe(false);
  });
});
