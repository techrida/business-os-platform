// Table tests of the sourcing rules, with PR_COMMITMENT_WORKFLOW_SPEC routed by the real approvals router.
// Run: pnpm --filter @bos/api exec vitest run src/modules/procurement/sourcing/sourcing.rules.test.ts
import { WorkflowSpecSchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { buildDirectory, route, type DirectoryData } from '../../approvals/router';
import {
  CreateRfqBodySchema,
  ExtendRfqDeadlineBodySchema,
  PR_COMMITMENT_WORKFLOW_SPEC,
  commitmentFactsOf,
  extendDeadlineVerdict,
  isLateQuotation,
  poBandOf,
  quotationLineAmounts,
  quoteCountVerdict,
} from './sourcing.rules';

const spec = WorkflowSpecSchema.parse(PR_COMMITMENT_WORKFLOW_SPEC);

const dataWith = (management: string[]): DirectoryData => ({
  roleMembers: new Map([
    ['accountant', ['acct']],
    ['finance', ['fin']],
    ['management', management],
    ['founder', ['founder']],
  ]),
  groups: new Map(),
  delegations: [],
});

function plan(
  amountNpr: string,
  opts: { founder?: boolean; mgmt?: string[]; sod?: string[] } = {},
) {
  const sod = opts.sod ?? ['requester'];
  const facts = commitmentFactsOf({
    amountNpr,
    requesterIsFounder: opts.founder ?? false,
    isEmergency: false,
  });
  const dir = buildDirectory(dataWith(opts.mgmt ?? ['mgmt1']), {
    now: new Date('2026-11-09T04:00:00Z'),
    documentType: 'pr_commitment',
    sodUserIds: sod,
  });
  return route(spec, facts, dir, sod);
}
const rolesOf = (p: ReturnType<typeof plan>) => p.steps.map((s) => s.roleKey);

describe('PR_COMMITMENT_WORKFLOW_SPEC (done check 2: bands, strict >)', () => {
  it.each([
    ['100000.00', ['accountant', 'finance']],
    ['100000.01', ['accountant', 'finance', 'management']],
    ['101700.00', ['accountant', 'finance', 'management']],
    ['1000000.00', ['accountant', 'finance', 'management']],
    ['1000000.01', ['accountant', 'finance', 'management', 'founder']],
  ])('%s NPR routes %j', (amount, roles) => {
    const p = plan(amount);
    expect(p.blocked).toBe(false);
    expect(rolesOf(p)).toEqual(roles);
  });

  it('net 90,000 + 13% VAT = 101,700.00 adds Management', () => {
    const line = quotationLineAmounts('1', '90000.00', 1300);
    expect(line).toEqual({ gross: '90000.00', taxAmount: '11700.00', lineTotal: '101700.00' });
    expect(rolesOf(plan(line.lineTotal))).toContain('management');
  });
});

describe('separation of duties (done check 4)', () => {
  it('the recommender in sodUserIds is never eligible', () => {
    const p = plan('100000.00', { sod: ['requester', 'acct'] });
    expect(p.steps[0]!.eligibleUserIds).toEqual([]);
    expect(p.blocked).toBe(true);
  });
});

describe('Founder as requester (AD8, done check 5)', () => {
  it('two distinct Management steps replace the Founder step', () => {
    const p = plan('1500000.00', { founder: true, mgmt: ['mgmt1', 'mgmt2'] });
    expect(rolesOf(p)).toEqual(['accountant', 'finance', 'management', 'management']);
    expect(p.blocked).toBe(false);
  });

  it('with one Management user the router blocks the second Management step', () => {
    const p = plan('1500000.00', { founder: true, mgmt: ['mgmt1'] });
    expect(p.steps.map((s) => s.blocked)).toEqual([false, false, false, true]);
    expect(p.blocked).toBe(true);
    expect(p.blockReason).toBe(
      "Step 4 (role management) has no eligible approver distinct from the other steps' approvers",
    );
  });

  it('a Founder request at exactly 1,000,000.00 has a single Management step', () => {
    expect(rolesOf(plan('1000000.00', { founder: true }))).toEqual([
      'accountant',
      'finance',
      'management',
    ]);
  });
});

describe('poBandOf (CT approved_band)', () => {
  it.each([
    ['100000.00', 'base'],
    ['100000.01', 'management'],
    ['1000000.00', 'management'],
    ['1000000.01', 'founder'],
  ])('%s -> %s', (amount, band) => {
    expect(poBandOf(amount)).toBe(band);
  });
});

describe('quoteCountVerdict (AD13, AD12)', () => {
  const base = {
    count: 3,
    minQuotes: 3,
    fewerThanThreeReason: undefined,
    isEmergency: false,
    emergencyReason: null,
  };
  it('three quotes need no reason', () => {
    expect(quoteCountVerdict(base)).toEqual({ ok: true, fewerThanThreeReason: null });
  });
  it('two quotes without a reason are refused', () => {
    expect(quoteCountVerdict({ ...base, count: 2 }).ok).toBe(false);
  });
  it('two quotes with a reason pass and keep it', () => {
    expect(
      quoteCountVerdict({ ...base, count: 2, fewerThanThreeReason: 'Sole distributor' }),
    ).toEqual({ ok: true, fewerThanThreeReason: 'Sole distributor' });
  });
  it('an emergency request goes below three on its emergency reason', () => {
    expect(
      quoteCountVerdict({ ...base, count: 1, isEmergency: true, emergencyReason: 'Server down' }),
    ).toEqual({ ok: true, fewerThanThreeReason: 'Emergency purchase: Server down' });
  });
  it('no quotation is refused even in an emergency', () => {
    expect(
      quoteCountVerdict({ ...base, count: 0, isEmergency: true, emergencyReason: 'x' }).ok,
    ).toBe(false);
  });
});

describe('CreateRfqBodySchema', () => {
  it('refuses a duplicated vendor', () => {
    const id = '0f8c2b1e-3a4d-4c5e-8f6a-7b8c9d0e1f2a';
    const r = CreateRfqBodySchema.safeParse({
      purchaseRequestId: id,
      deadline: '2026-11-20T10:00:00+05:45',
      vendorIds: [id, id],
    });
    expect(r.success).toBe(false);
  });
});

describe('isLateQuotation (F1-Q47)', () => {
  const deadline = new Date('2026-11-20T10:00:00+05:45');
  it('takes a quotation that arrives at the deadline itself', () => {
    expect(isLateQuotation(deadline, new Date('2026-11-20T04:15:00.000Z'))).toBe(false);
  });
  it('refuses one a millisecond after the deadline', () => {
    expect(isLateQuotation(deadline, new Date('2026-11-20T04:15:00.001Z'))).toBe(true);
  });
  it('takes one before the deadline', () => {
    expect(isLateQuotation(deadline, new Date('2026-11-19T23:59:00+05:45'))).toBe(false);
  });
});

describe('extendDeadlineVerdict (F1-Q47)', () => {
  const now = new Date('2026-11-21T00:00:00Z');
  const current = new Date('2026-11-20T04:15:00Z');
  const later = new Date('2026-11-25T04:15:00Z');
  it('extends an open RFQ, also one whose deadline has passed', () => {
    expect(extendDeadlineVerdict({ status: 'open', current, next: later, now })).toEqual({
      ok: true,
    });
  });
  it.each(['closed', 'recommended', 'cancelled'])('refuses a %s RFQ', (status) => {
    expect(extendDeadlineVerdict({ status, current, next: later, now })).toEqual({
      ok: false,
      refusal: 'not_open',
    });
  });
  it('refuses a new deadline that is not after now', () => {
    expect(extendDeadlineVerdict({ status: 'open', current, next: now, now })).toEqual({
      ok: false,
      refusal: 'deadline_in_past',
    });
  });
  it('refuses a new deadline that is not after the current one', () => {
    const future = new Date('2026-12-10T00:00:00Z');
    expect(
      extendDeadlineVerdict({ status: 'open', current: future, next: future, now }),
    ).toEqual({ ok: false, refusal: 'not_later' });
    expect(
      extendDeadlineVerdict({
        status: 'open',
        current: future,
        next: new Date('2026-12-01T00:00:00Z'),
        now,
      }),
    ).toEqual({ ok: false, refusal: 'not_later' });
  });
});

describe('ExtendRfqDeadlineBodySchema', () => {
  it('takes a zoned instant and nothing else', () => {
    expect(ExtendRfqDeadlineBodySchema.safeParse({ deadline: '2026-11-25T10:00:00+05:45' }).success).toBe(
      true,
    );
    expect(ExtendRfqDeadlineBodySchema.safeParse({ deadline: '2026-11-25' }).success).toBe(false);
    expect(
      ExtendRfqDeadlineBodySchema.safeParse({ deadline: '2026-11-25T10:00:00Z', status: 'open' })
        .success,
    ).toBe(false);
  });
});
