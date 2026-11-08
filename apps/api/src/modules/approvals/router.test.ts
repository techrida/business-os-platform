// Table tests for the pure router and directory: the seed's test_memo route, rule placement, groups,
// delegation windows and separation of duties. No database: these are the money-path rules themselves.
import { WorkflowSpecSchema, type WorkflowSpec } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { ConditionError } from './conditions';
import { buildDirectory, delegationActive, route, type DirectoryData } from './router';

/** The seed's workflow (P1-PLAN section 6.2, U8): accountant, finance, then amount rules. */
const seedSpec: WorkflowSpec = WorkflowSpecSchema.parse({
  documentType: 'test_memo',
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: 'Base route: accountant checks the memo',
    },
    { id: 'finance', kind: 'role', role: 'finance', reason: 'Base route: finance approves' },
  ],
  rules: [
    {
      id: 'over-1-lakh',
      when: { field: 'amountNpr', op: 'gt', value: '100000' },
      add: { id: 'management', kind: 'role', role: 'management', reason: 'Management approval' },
      position: 'end',
      reason: 'Management approval because NPR equivalent exceeds 1,00,000',
    },
    {
      id: 'over-10-lakh',
      when: { field: 'amountNpr', op: 'gt', value: '1000000' },
      add: { id: 'founder', kind: 'role', role: 'founder', reason: 'Founder approval' },
      position: 'end',
      reason: 'Founder approval because NPR equivalent exceeds 10,00,000',
    },
  ],
});

const NOW = new Date('2026-11-08T06:00:00Z');
const people: DirectoryData = {
  roleMembers: new Map([
    ['accountant', ['acc-1']],
    ['finance', ['fin-1', 'fin-2']],
    ['management', ['mgmt-1']],
    ['founder', ['founder-1']],
  ]),
  groups: new Map([['treasury', { id: 'group-uuid-1', memberIds: ['t-1', 't-2'] }]]),
  delegations: [],
};
const dir = buildDirectory(people, { now: NOW, documentType: 'test_memo' });

describe('route: the seed test_memo workflow', () => {
  it.each([
    ['50000.00', ['accountant', 'finance']],
    ['100000.00', ['accountant', 'finance']],
    ['100000.01', ['accountant', 'finance', 'management']],
    ['1000000.00', ['accountant', 'finance', 'management']],
    ['1000000.01', ['accountant', 'finance', 'management', 'founder']],
  ])('amountNpr %s routes to %j', (amountNpr, roles) => {
    const plan = route(seedSpec, { amountNpr }, dir, []);
    expect(plan.steps.map((s) => s.roleKey)).toEqual(roles);
    expect(plan.steps.map((s) => s.seq)).toEqual(roles.map((_, i) => i + 1));
    expect(plan.blocked).toBe(false);
  });

  it('gives each step its reason, in order, with the founder last', () => {
    const plan = route(seedSpec, { amountNpr: '1250000.00' }, dir, []);
    expect(plan.steps.map((s) => s.reason)).toEqual([
      'Base route: accountant checks the memo',
      'Base route: finance approves',
      'Management approval because NPR equivalent exceeds 1,00,000',
      'Founder approval because NPR equivalent exceeds 10,00,000',
    ]);
    expect(plan.steps[1]?.eligibleUserIds).toEqual(['fin-1', 'fin-2']);
  });

  it('refuses facts that cannot be evaluated instead of skipping the rule', () => {
    expect(() => route(seedSpec, {}, dir, [])).toThrow(ConditionError);
  });
});

describe('route: rule placement', () => {
  const base = {
    documentType: 'x',
    steps: [
      { id: 'a', kind: 'role', role: 'accountant', reason: 'A' },
      { id: 'b', kind: 'role', role: 'finance', reason: 'B' },
    ],
  };
  const always = { field: 'flag', op: 'eq', value: true } as const;

  it('keeps rule order for two rules placed after the same step', () => {
    const spec = WorkflowSpecSchema.parse({
      ...base,
      rules: [
        {
          id: 'r1',
          when: always,
          add: { id: 'm', kind: 'role', role: 'management', reason: 'm' },
          position: { after: 'a' },
          reason: 'R1',
        },
        {
          id: 'r2',
          when: always,
          add: { id: 'f', kind: 'role', role: 'founder', reason: 'f' },
          position: { after: 'a' },
          reason: 'R2',
        },
      ],
    });
    const plan = route(spec, { flag: true }, dir, []);
    expect(plan.steps.map((s) => s.reason)).toEqual(['A', 'R1', 'R2', 'B']);
  });

  it('appends a step whose anchor is a rule step that did not fire', () => {
    const spec = WorkflowSpecSchema.parse({
      ...base,
      rules: [
        {
          id: 'r1',
          when: { field: 'flag', op: 'eq', value: false },
          add: { id: 'm', kind: 'role', role: 'management', reason: 'm' },
          position: 'end',
          reason: 'R1',
        },
        {
          id: 'r2',
          when: always,
          add: { id: 'f', kind: 'role', role: 'founder', reason: 'f' },
          position: { after: 'm' },
          reason: 'R2',
        },
      ],
    });
    expect(route(spec, { flag: true }, dir, []).steps.map((s) => s.reason)).toEqual([
      'A',
      'B',
      'R2',
    ]);
  });

  it('treats an empty plan as blocked rather than approved', () => {
    const spec = WorkflowSpecSchema.parse({ documentType: 'x', steps: [] });
    const plan = route(spec, {}, dir, []);
    expect(plan).toMatchObject({
      blocked: true,
      blockReason: 'The workflow produced no approval steps',
    });
  });
});

describe('route: groups, users, delegation and separation of duties', () => {
  it('a group step lists every member (any one of them may approve) and carries the group id', () => {
    const spec = WorkflowSpecSchema.parse({
      documentType: 'x',
      steps: [{ id: 'g', kind: 'group', group: 'treasury', reason: 'Treasury signs' }],
    });
    const [step] = route(spec, {}, dir, []).steps;
    expect(step).toMatchObject({
      kind: 'group',
      groupId: 'group-uuid-1',
      eligibleUserIds: ['t-1', 't-2'],
    });
  });

  it('a user step names that user', () => {
    const spec = WorkflowSpecSchema.parse({
      documentType: 'x',
      steps: [{ id: 'u', kind: 'user', user: 'u-9', reason: 'Named approver' }],
    });
    expect(route(spec, {}, dir, []).steps[0]).toMatchObject({
      userId: 'u-9',
      eligibleUserIds: ['u-9'],
    });
  });

  const delegation = {
    fromUserId: 'acc-1',
    toUserId: 'deputy-1',
    startsAt: new Date('2026-11-01T00:00:00Z'),
    endsAt: new Date('2026-11-10T00:00:00Z'),
    documentType: null,
    revokedAt: null,
  };

  it.each([
    ['inside its dates', NOW, true],
    ['at its start (inclusive)', delegation.startsAt, true],
    ['at its end (exclusive)', delegation.endsAt, false],
    ['before its dates', new Date('2026-10-31T23:59:59Z'), false],
    ['after its dates', new Date('2026-11-11T00:00:00Z'), false],
  ])('a delegation %s adds the delegate: %s', (_label, now, expected) => {
    const d = buildDirectory(
      { ...people, delegations: [delegation] },
      { now, documentType: 'test_memo' },
    );
    const plan = route(seedSpec, { amountNpr: '10' }, d, []);
    expect(plan.steps[0]?.eligibleUserIds.includes('deputy-1')).toBe(expected);
  });

  it('ignores revoked delegations and ones for another document type', () => {
    expect(delegationActive({ ...delegation, revokedAt: NOW }, NOW, 'test_memo')).toBe(false);
    expect(delegationActive({ ...delegation, documentType: 'invoice' }, NOW, 'test_memo')).toBe(
      false,
    );
    expect(delegationActive({ ...delegation, documentType: 'test_memo' }, NOW, 'test_memo')).toBe(
      true,
    );
  });

  it('SoD empties a step, which blocks the whole plan with a reason', () => {
    const plan = route(seedSpec, { amountNpr: '10' }, dir, ['acc-1']);
    expect(plan.steps[0]).toMatchObject({ eligibleUserIds: [], blocked: true });
    expect(plan.steps[1]?.blocked).toBe(false);
    expect(plan.blocked).toBe(true);
    expect(plan.blockReason).toContain('Step 1 (role accountant)');
  });

  it("never lets the requester's delegate approve on the requester's behalf", () => {
    const d = buildDirectory(
      { ...people, delegations: [delegation] },
      { now: NOW, documentType: 'test_memo', sodUserIds: ['acc-1'] },
    );
    const plan = route(seedSpec, { amountNpr: '10' }, d, ['acc-1']);
    expect(plan.steps[0]?.eligibleUserIds).toEqual([]);
    expect(d.resolveActor(seedSpec.steps[0]!, 'deputy-1')).toEqual({
      eligible: false,
      onBehalfOf: null,
    });
  });

  it('resolveActor tells a direct approver from a delegate and refuses others', () => {
    const d = buildDirectory(
      { ...people, delegations: [delegation] },
      { now: NOW, documentType: 'test_memo' },
    );
    const step = seedSpec.steps[0]!;
    expect(d.resolveActor(step, 'acc-1')).toEqual({ eligible: true, onBehalfOf: null });
    expect(d.resolveActor(step, 'deputy-1')).toEqual({ eligible: true, onBehalfOf: 'acc-1' });
    expect(d.resolveActor(step, 'fin-1')).toEqual({ eligible: false, onBehalfOf: null });
  });

  it('a user step whose user is not active has no approver (R24)', () => {
    const d = buildDirectory(
      { ...people, activeUserIds: new Set(['acc-1']) },
      { now: NOW, documentType: 'test_memo' },
    );
    const step = (user: string) => ({ id: 'u', kind: 'user' as const, user, reason: 'Named' });
    expect(d.eligible(step('gone-1'))).toEqual([]);
    expect(d.eligible(step('acc-1'))).toEqual(['acc-1']);
  });
});

describe('route: distinct approvers across a request (R12)', () => {
  // u-1 holds both roles and is finance's only member, so after u-1 decides step 1, step 2 has nobody.
  const spec = (distinctApprovers: boolean) =>
    WorkflowSpecSchema.parse({
      documentType: 'test_memo',
      distinctApprovers,
      steps: [
        { id: 'a', kind: 'role', role: 'accountant', reason: 'A' },
        { id: 'b', kind: 'role', role: 'finance', reason: 'B' },
      ],
    });
  const twoHats: DirectoryData = {
    roleMembers: new Map([
      ['accountant', ['u-1', 'u-2']],
      ['finance', ['u-1']],
    ]),
    groups: new Map(),
    delegations: [],
  };
  const decided = [{ seq: 1, deciders: ['u-1'] }];

  it('a later step whose only candidate decided an earlier step has no approver', () => {
    const d = buildDirectory(twoHats, { now: NOW, documentType: 'test_memo' });
    const plan = route(spec(true), {}, d, [], decided);
    expect(plan.steps[0]?.eligibleUserIds).toEqual(['u-1', 'u-2']);
    expect(plan.steps[1]).toMatchObject({ eligibleUserIds: [], blocked: true });
    expect(plan.blocked).toBe(true);
    expect(plan.blockReason).toContain('Step 2 (role finance)');
  });

  it('keeps the earlier decider eligible when distinctApprovers is off', () => {
    const d = buildDirectory(twoHats, { now: NOW, documentType: 'test_memo' });
    const plan = route(spec(false), {}, d, [], decided);
    expect(plan.steps[1]).toMatchObject({ eligibleUserIds: ['u-1'], blocked: false });
  });

  it("does not let the earlier decider's delegate fill the step on their behalf", () => {
    const d = buildDirectory(
      {
        ...twoHats,
        delegations: [
          {
            fromUserId: 'u-1',
            toUserId: 'deputy-1',
            startsAt: new Date('2026-11-01T00:00:00Z'),
            endsAt: new Date('2026-11-30T00:00:00Z'),
            documentType: null,
            revokedAt: null,
          },
        ],
      },
      { now: NOW, documentType: 'test_memo' },
    );
    const plan = route(spec(true), {}, d, [], decided);
    expect(plan.steps[1]).toMatchObject({ eligibleUserIds: [], blocked: true });
  });
});

describe('resolveActor: which approver a delegate acts for (R12)', () => {
  // act() passes the SoD people and, under distinctApprovers, the earlier deciders as preferNot, so a
  // delegate for both u-1 (decided step 1) and u-2 acts for u-2 instead of being refused.
  const deputyFor = (from: string) => ({
    fromUserId: from,
    toUserId: 'deputy-1',
    startsAt: new Date('2026-11-01T00:00:00Z'),
    endsAt: new Date('2026-11-30T00:00:00Z'),
    documentType: null,
    revokedAt: null,
  });
  const d = buildDirectory(
    {
      roleMembers: new Map([['finance', ['u-1', 'u-2']]]),
      groups: new Map(),
      delegations: [deputyFor('u-1'), deputyFor('u-2')],
    },
    { now: NOW, documentType: 'test_memo' },
  );
  const finance = { id: 'b', kind: 'role', role: 'finance', reason: 'B' } as const;

  it('skips an approver in preferNot when another one delegated too', () => {
    expect(d.resolveActor(finance, 'deputy-1')).toEqual({ eligible: true, onBehalfOf: 'u-1' });
    expect(d.resolveActor(finance, 'deputy-1', new Set(['u-1']))).toEqual({
      eligible: true,
      onBehalfOf: 'u-2',
    });
  });

  it('falls back to an approver in preferNot when nobody else delegated', () => {
    expect(d.resolveActor(finance, 'deputy-1', new Set(['u-1', 'u-2']))).toEqual({
      eligible: true,
      onBehalfOf: 'u-1',
    });
  });
});

describe('route: reasons fill {fact} placeholders from the request facts', () => {
  const discountSpec: WorkflowSpec = WorkflowSpecSchema.parse({
    documentType: 'quotation',
    steps: [{ id: 'sales', kind: 'role', role: 'accountant', reason: 'Base route: sales checks' }],
    rules: [
      {
        id: 'discount',
        when: { field: 'effectiveDiscountPct', op: 'gt', value: '12' },
        add: { id: 'management', kind: 'role', role: 'management', reason: 'Management' },
        position: 'end',
        reason: 'Discount {effectiveDiscountPct}% exceeds permitted 12%',
      },
    ],
  });
  const reasonOf = (facts: Record<string, unknown>) =>
    route(discountSpec, facts, dir, []).steps[1]?.reason;

  it('renders a decimal string exactly', () => {
    expect(reasonOf({ effectiveDiscountPct: '12.0001' })).toBe(
      'Discount 12.0001% exceeds permitted 12%',
    );
  });

  it('keeps the written scale of a decimal string (money keeps its zeros)', () => {
    expect(reasonOf({ effectiveDiscountPct: '12.50' })).toBe(
      'Discount 12.50% exceeds permitted 12%',
    );
  });

  it('renders a number and a decimal beyond float precision without exponent or rounding', () => {
    expect(reasonOf({ effectiveDiscountPct: 12.0001 })).toBe(
      'Discount 12.0001% exceeds permitted 12%',
    );
    expect(reasonOf({ effectiveDiscountPct: '12.000000000000000000001' })).toBe(
      'Discount 12.000000000000000000001% exceeds permitted 12%',
    );
    expect(reasonOf({ effectiveDiscountPct: 1e21 })).toBe(
      'Discount 1000000000000000000000% exceeds permitted 12%',
    );
  });

  const loose = (reason: string, facts: Record<string, unknown>) =>
    route(
      WorkflowSpecSchema.parse({
        ...discountSpec,
        rules: [{ ...discountSpec.rules[0], reason }],
      }),
      facts,
      dir,
      [],
    ).steps[1]?.reason;
  const over = { effectiveDiscountPct: '13' };

  it('leaves an unknown placeholder literal', () => {
    expect(loose('Because {nope} and {effectiveDiscountPct}', over)).toBe('Because {nope} and 13');
  });

  it('never reads inherited or non-scalar data into a reason', () => {
    expect(loose('{constructor} {__proto__} {toString}', over)).toBe(
      '{constructor} {__proto__} {toString}',
    );
    expect(
      loose('{obj} {list} {nothing}', { ...over, obj: { a: 1 }, list: [1], nothing: null }),
    ).toBe('{obj} {list} {nothing}');
  });

  it('reads nested facts, strings and booleans, and does not expand values twice', () => {
    expect(
      loose('{customer.tier} {flag} {note}', {
        ...over,
        customer: { tier: 'gold' },
        flag: true,
        note: '{effectiveDiscountPct}',
      }),
    ).toBe('gold true {effectiveDiscountPct}');
  });

  it('does not touch reasons without placeholders (memo reasons) or escape plain text', () => {
    const plan = route(seedSpec, { amountNpr: '1250000.00' }, dir, []);
    expect(plan.steps[2]?.reason).toBe(
      'Management approval because NPR equivalent exceeds 1,00,000',
    );
    expect(loose('A <b>&</b> {tag}', { ...over, tag: '<i>&' })).toBe('A <b>&</b> <i>&');
  });
});
