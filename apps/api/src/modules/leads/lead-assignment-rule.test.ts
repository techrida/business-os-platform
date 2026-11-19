// The D50 assignment rule as a table: who may hand a lead to whom, and why not.
import type { AccessLevel, AssignmentParty, RoleKey } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { assignableTargets, decideAssignment, defaultSalesOwner } from './lead-assignment-rule';

const SALES_DEPT = 'dept-sales';
const MARKETING_DEPT = 'dept-marketing';

function party(
  userId: string,
  roleKeys: RoleKey[],
  departmentId: string | null,
  level: AccessLevel = 'staff',
): AssignmentParty {
  return { userId, roleKeys, departmentId, level };
}

const founder = party('founder', ['founder'], null);
const salesStaff = party('sales-staff', ['sales'], SALES_DEPT);
const salesPeer = party('sales-peer', ['sales'], SALES_DEPT);
const salesManager = party('sales-manager', ['sales'], SALES_DEPT, 'manager');
const salesHead = party('sales-head', ['sales'], SALES_DEPT, 'head');
const marketingStaff = party('mkt-staff', ['marketing'], MARKETING_DEPT);
const marketingManager = party('mkt-manager', ['marketing'], MARKETING_DEPT, 'manager');
const marketingHead = party('mkt-head', ['marketing'], MARKETING_DEPT, 'head');
const finance = party('finance', ['finance'], 'dept-finance');
const unplaced = party('unplaced', ['sales'], null);

type Row = [string, AssignmentParty, AssignmentParty, 'create' | 'reassign', string];

const rows: Row[] = [
  ['founder to anyone', founder, salesHead, 'reassign', 'allow:founder'],
  ['founder to a person with no department', founder, unplaced, 'reassign', 'allow:founder'],
  ['self, with a department', salesStaff, salesStaff, 'reassign', 'allow:self'],
  ['self, without a department', unplaced, unplaced, 'reassign', 'allow:self'],
  ['staff to a same-level peer', salesStaff, salesPeer, 'reassign', 'allow:department'],
  ['staff to a manager (upward)', salesStaff, salesManager, 'reassign', 'deny:upward'],
  ['staff to the head (upward)', salesStaff, salesHead, 'reassign', 'deny:upward'],
  ['manager to staff', salesManager, salesStaff, 'reassign', 'allow:department'],
  [
    'manager to a manager',
    salesManager,
    party('m2', ['sales'], SALES_DEPT, 'manager'),
    'reassign',
    'allow:department',
  ],
  ['manager to the head (upward)', salesManager, salesHead, 'reassign', 'deny:upward'],
  ['head to a manager', salesHead, salesManager, 'reassign', 'allow:department'],
  ['head to staff', salesHead, salesStaff, 'reassign', 'allow:department'],
  ['Marketing staff to Sales staff', marketingStaff, salesStaff, 'reassign', 'allow:sales_handoff'],
  [
    'Marketing staff to a Sales manager (upward)',
    marketingStaff,
    salesManager,
    'reassign',
    'deny:upward',
  ],
  [
    'Marketing manager to a Sales manager',
    marketingManager,
    salesManager,
    'reassign',
    'allow:sales_handoff',
  ],
  [
    'Marketing manager to the Sales head (upward)',
    marketingManager,
    salesHead,
    'reassign',
    'deny:upward',
  ],
  ['Marketing head to the Sales head', marketingHead, salesHead, 'reassign', 'allow:sales_handoff'],
  [
    'Marketing staff to a Marketing peer',
    marketingStaff,
    party('mkt-peer', ['marketing'], MARKETING_DEPT),
    'reassign',
    'allow:department',
  ],
  [
    'Sales head to Marketing staff (reverse)',
    salesHead,
    marketingStaff,
    'reassign',
    'deny:reverse_handoff',
  ],
  [
    'Sales staff to a Marketing head (reverse)',
    salesStaff,
    marketingHead,
    'reassign',
    'deny:reverse_handoff',
  ],
  ['Sales to another department', salesHead, finance, 'reassign', 'deny:other_department'],
  [
    'caller without a department to a colleague',
    unplaced,
    salesStaff,
    'reassign',
    'deny:no_department',
  ],
  [
    'colleague without a department as target',
    salesStaff,
    unplaced,
    'reassign',
    'deny:no_department',
  ],
  [
    'Finance picks a Sales staff owner on create',
    finance,
    salesStaff,
    'create',
    'allow:intake_handoff',
  ],
  ['Finance picks the Sales head on create', finance, salesHead, 'create', 'allow:intake_handoff'],
  ['Finance reassigns to Sales later', finance, salesStaff, 'reassign', 'deny:other_department'],
  [
    'Finance picks Marketing on create',
    finance,
    marketingStaff,
    'create',
    'deny:sales_owner_required',
  ],
  [
    'Finance keeps the lead itself on create',
    finance,
    finance,
    'create',
    'deny:sales_owner_required',
  ],
  [
    'Finance picks a Finance colleague on create',
    finance,
    party('fin2', ['finance'], 'dept-finance'),
    'create',
    'deny:sales_owner_required',
  ],
  [
    'Finance picks an unplaced Sales user on create',
    finance,
    unplaced,
    'create',
    'deny:no_department',
  ],
  [
    'Finance sharing a department with the Sales head still picks them on create',
    party('fin-hq', ['finance'], SALES_DEPT),
    salesHead,
    'create',
    'allow:intake_handoff',
  ],
  [
    'Finance who also holds Marketing still picks the Sales head on create',
    party('fin-mkt', ['finance', 'marketing'], MARKETING_DEPT),
    salesHead,
    'create',
    'allow:intake_handoff',
  ],
  [
    'Sales head to Marketing staff inside one shared department',
    party('s-hq', ['sales'], 'dept-hq', 'head'),
    party('m-hq', ['marketing'], 'dept-hq'),
    'reassign',
    'deny:reverse_handoff',
  ],
  [
    'Marketing to an unplaced Sales user',
    marketingStaff,
    unplaced,
    'reassign',
    'deny:no_department',
  ],
  [
    'Unplaced Marketing user to Sales',
    party('mkt-unplaced', ['marketing'], null),
    salesStaff,
    'reassign',
    'deny:no_department',
  ],
  [
    'Accountant picks Sales on create',
    party('acc', ['accountant'], 'dept-acc'),
    salesStaff,
    'create',
    'allow:intake_handoff',
  ],
  [
    'PMO picks Sales on create',
    party('pmo', ['pmo'], null),
    salesStaff,
    'create',
    'allow:intake_handoff',
  ],
  [
    'Management cannot assign across departments',
    party('mgmt', ['management'], 'dept-mgmt'),
    salesStaff,
    'create',
    'deny:other_department',
  ],
  [
    'Sales and Marketing together reaches Sales',
    party('both', ['sales', 'marketing'], MARKETING_DEPT),
    salesStaff,
    'reassign',
    'allow:sales_handoff',
  ],
  [
    'Sales and Marketing together is not blocked by the reverse rule',
    party('both', ['sales', 'marketing'], null),
    marketingStaff,
    'reassign',
    'deny:no_department',
  ],
];

describe('decideAssignment', () => {
  it.each(rows)('%s', (_name, actor, target, context, expected) => {
    const decision = decideAssignment(actor, target, context);
    expect(`${decision.allowed ? 'allow' : 'deny'}:${decision.reason}`).toBe(expected);
  });

  it('defaults the context to reassign, which never grants the intake hand-off', () => {
    expect(decideAssignment(finance, salesStaff)).toEqual({
      allowed: false,
      reason: 'other_department',
    });
  });

  it('refuses nobody upward and nobody across departments without a hand-off rule', () => {
    const everyone = [
      founder,
      salesStaff,
      salesPeer,
      salesManager,
      salesHead,
      marketingStaff,
      marketingManager,
      marketingHead,
      finance,
      unplaced,
      party('s-hq', ['sales'], 'dept-hq', 'head'),
      party('m-hq', ['marketing'], 'dept-hq'),
      party('both', ['sales', 'marketing'], MARKETING_DEPT, 'manager'),
    ];
    const levels = ['staff', 'manager', 'head'];
    for (const context of ['create', 'reassign'] as const) {
      for (const actor of everyone) {
        for (const target of everyone) {
          const decision = decideAssignment(actor, target, context);
          if (!decision.allowed) continue;
          const label = `${actor.userId} -> ${target.userId} (${context}): ${decision.reason}`;
          const upward = levels.indexOf(target.level) > levels.indexOf(actor.level);
          switch (decision.reason) {
            case 'founder':
              expect(actor.roleKeys, label).toContain('founder');
              break;
            case 'self':
              expect(target.userId, label).toBe(actor.userId);
              break;
            case 'department':
              expect(target.departmentId, label).toBe(actor.departmentId);
              expect(upward, label).toBe(false);
              break;
            case 'sales_handoff':
              expect(actor.roleKeys, label).toContain('marketing');
              expect(target.roleKeys, label).toContain('sales');
              expect(upward, label).toBe(false);
              break;
            case 'intake_handoff':
              expect(context, label).toBe('create');
              expect(target.roleKeys, label).toContain('sales');
              expect(target.departmentId, label).not.toBeNull();
              break;
          }
          // Sales never reaches a Marketing-only user, in either context.
          if (actor.roleKeys.includes('sales') && !actor.roleKeys.includes('marketing')) {
            const marketingOnly =
              target.roleKeys.includes('marketing') && !target.roleKeys.includes('sales');
            if (marketingOnly) expect(target.userId, label).toBe(actor.userId);
          }
        }
      }
    }
  });
});

describe('assignableTargets', () => {
  const everyone = [
    founder,
    salesStaff,
    salesPeer,
    salesManager,
    salesHead,
    marketingStaff,
    marketingHead,
    finance,
  ];

  it('lists exactly the people decideAssignment accepts, in order', () => {
    for (const actor of everyone) {
      const listed = assignableTargets(actor, everyone).map((p) => p.userId);
      const accepted = everyone
        .filter((p) => decideAssignment(actor, p).allowed)
        .map((p) => p.userId);
      expect(listed).toEqual(accepted);
    }
  });

  it('lets a Sales staff member pick themselves and their peers only', () => {
    expect(assignableTargets(salesStaff, everyone).map((p) => p.userId)).toEqual([
      'sales-staff',
      'sales-peer',
    ]);
  });

  it('shows Marketing the Sales people up to their own level, and itself', () => {
    expect(assignableTargets(marketingStaff, everyone).map((p) => p.userId)).toEqual([
      'sales-staff',
      'sales-peer',
      'mkt-staff',
    ]);
  });

  it('shows Finance the Sales people only when starting a lead', () => {
    expect(assignableTargets(finance, everyone, 'create').map((p) => p.userId)).toEqual([
      'sales-staff',
      'sales-peer',
      'sales-manager',
      'sales-head',
    ]);
    expect(assignableTargets(finance, everyone, 'reassign').map((p) => p.userId)).toEqual([
      'finance',
    ]);
  });
});

describe('defaultSalesOwner', () => {
  it('is the Sales head', () => {
    expect(defaultSalesOwner([salesStaff, salesManager, salesHead, marketingHead])).toBe(
      'sales-head',
    );
  });

  it('breaks a tie between heads by the lowest user id, whatever the list order', () => {
    const other = party('a-head', ['sales'], SALES_DEPT, 'head');
    expect(defaultSalesOwner([salesHead, other])).toBe('a-head');
    expect(defaultSalesOwner([other, salesHead])).toBe('a-head');
  });

  it('is null with no Sales head', () => {
    expect(defaultSalesOwner([salesStaff, salesManager, marketingHead])).toBeNull();
    expect(defaultSalesOwner([])).toBeNull();
  });
});
