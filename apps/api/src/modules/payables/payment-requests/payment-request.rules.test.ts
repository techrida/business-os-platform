// Unit tests of the payment request rules (P4 unit A2): the workflow spec routes (AD4, AD5, AD8) through the real
// router, the facts, the SoD set (check 4), the line checks and the status moves.
import { WorkflowSpecSchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { buildDirectory, route, type DirectoryData } from '../../approvals/router';
import {
  ListPaymentRequestsQuerySchema,
  PAYMENT_REQUEST_WORKFLOW_SPEC,
  allPoMatchedOf,
  amountNprOf,
  canCancel,
  exceedsOpen,
  paymentRequestFactsOf,
  repeatedOpenItem,
  separatedUsers,
  statusAfter,
} from './payment-request.rules';

const spec = WorkflowSpecSchema.parse(PAYMENT_REQUEST_WORKFLOW_SPEC);

const people: DirectoryData = {
  roleMembers: new Map([
    ['finance', ['fin-1']],
    ['management', ['mgmt-1', 'mgmt-2']],
    ['founder', ['founder-1']],
  ]),
  groups: new Map(),
  delegations: [],
};
const dir = buildDirectory(people, {
  now: new Date('2026-11-09T04:00:00Z'),
  documentType: 'payment_request',
});

/** The role keys of the steps the real router plans for these facts. */
function rolesFor(amountNpr: string, allPoMatched: boolean, requesterIsFounder = false): string[] {
  const facts = paymentRequestFactsOf({ amountNpr, allPoMatched, requesterIsFounder });
  const plan = route(spec, facts, dir, []);
  expect(plan.blocked).toBe(false);
  return plan.steps.map((s) => s.roleKey ?? s.kind);
}

describe('PAYMENT_REQUEST_WORKFLOW_SPEC', () => {
  it('parses and keeps approvers distinct', () => {
    expect(spec.documentType).toBe('payment_request');
    expect(spec.distinctApprovers).toBe(true);
  });

  it('routes Finance only when every bill is PO-matched, whatever the amount (AD5)', () => {
    expect(rolesFor('5000000.00', true)).toEqual(['finance']);
  });

  it('adds the AD4 bands otherwise, strictly above the thresholds', () => {
    expect(rolesFor('100000.00', false)).toEqual(['finance']);
    expect(rolesFor('100000.01', false)).toEqual(['finance', 'management']);
    expect(rolesFor('1000000.00', false)).toEqual(['finance', 'management']);
    expect(rolesFor('1000000.01', false)).toEqual(['finance', 'management', 'founder']);
  });

  it('replaces the Founder step with a second Management step for a Founder requester (AD8)', () => {
    expect(rolesFor('1000000.01', false, true)).toEqual(['finance', 'management', 'management']);
  });

  it('blocks the AD8 route when only one Management user can take both steps', () => {
    const one = buildDirectory(
      { ...people, roleMembers: new Map([...people.roleMembers, ['management', ['mgmt-1']]]) },
      { now: new Date('2026-11-09T04:00:00Z'), documentType: 'payment_request' },
    );
    const facts = paymentRequestFactsOf({
      amountNpr: '1500000.00',
      allPoMatched: false,
      requesterIsFounder: true,
    });
    expect(route(spec, facts, one, []).blocked).toBe(true);
  });
});

describe('facts', () => {
  it('converts each line at its bill rate and sums in paisa', () => {
    expect(
      amountNprOf([
        { amount: '100.005', fxRate: '1' },
        { amount: '10.00', fxRate: '133.456789' },
      ]),
    ).toBe('1434.58');
  });

  it('counts only matched PO bills as PO-matched', () => {
    expect(allPoMatchedOf([{ purchaseOrderId: 'po', matchStatus: 'matched' }])).toBe(true);
    expect(allPoMatchedOf([{ purchaseOrderId: 'po', matchStatus: 'exception_approved' }])).toBe(
      false,
    );
    expect(
      allPoMatchedOf([
        { purchaseOrderId: 'po', matchStatus: 'matched' },
        { purchaseOrderId: null, matchStatus: 'not_required' },
      ]),
    ).toBe(false);
    expect(allPoMatchedOf([])).toBe(false);
  });
});

describe('separatedUsers (check 4)', () => {
  it('holds the requester, the submitter, the bill enterers and the bill approvers once each', () => {
    expect(
      separatedUsers({
        requester: 'r',
        submitter: 'r',
        billEnterers: ['e1', 'e2', 'e1'],
        billApprovers: ['a1', null, 'a2', 'r'],
      }),
    ).toEqual(['r', 'e1', 'e2', 'a1', 'a2']);
  });
});

describe('lines', () => {
  it('refuses more than the open amount less what other requests claim', () => {
    expect(exceedsOpen('100.00', '100.00')).toBe(false);
    expect(exceedsOpen('100.01', '100.00')).toBe(true);
    expect(exceedsOpen('60.00', '100.00', '40.00')).toBe(false);
    expect(exceedsOpen('60.01', '100.00', '40.00')).toBe(true);
  });

  it('finds an open item named twice', () => {
    expect(repeatedOpenItem([{ openItemId: 'A' }, { openItemId: 'b' }])).toBeUndefined();
    expect(repeatedOpenItem([{ openItemId: 'A' }, { openItemId: 'a' }])).toBe('a');
  });
});

describe('status', () => {
  it('cancels only a draft; approved is terminal', () => {
    expect(canCancel('draft')).toBe(true);
    for (const s of ['pending_approval', 'approved', 'rejected', 'cancelled'] as const) {
      expect(canCancel(s)).toBe(false);
    }
  });

  it('maps a returned decision to rejected (the contract has no way back to draft)', () => {
    expect(statusAfter('approved')).toBe('approved');
    expect(statusAfter('returned')).toBe('rejected');
    expect(statusAfter('rejected')).toBe('rejected');
  });
});

describe('ListPaymentRequestsQuerySchema', () => {
  it('takes a repeated status, a search and a page window, and pages 25 by default', () => {
    expect(ListPaymentRequestsQuerySchema.parse({})).toEqual({ limit: 25, offset: 0 });
    expect(
      ListPaymentRequestsQuerySchema.parse({
        status: ['draft', 'approved'],
        q: 'acme',
        limit: '50',
        offset: '25',
      }),
    ).toEqual({ status: ['draft', 'approved'], q: 'acme', limit: 50, offset: 25 });
  });

  it('refuses an unknown status, a big limit and an unknown key', () => {
    expect(ListPaymentRequestsQuerySchema.safeParse({ status: ['draft', 'nope'] }).success).toBe(
      false,
    );
    expect(ListPaymentRequestsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(ListPaymentRequestsQuerySchema.safeParse({ vendorId: 'x' }).success).toBe(false);
  });
});
