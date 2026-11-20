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

describe('route: department-head steps (M8, AD11)', () => {
  const headSpec = (step: Record<string, unknown> = {}) =>
    WorkflowSpecSchema.parse({
      documentType: 'purchase_request',
      steps: [
        { id: 'head', kind: 'department_head', reason: 'Department head approval', ...step },
        { id: 'finance', kind: 'role', role: 'finance', reason: 'Finance approves' },
      ],
    });
  const heads: DirectoryData = {
    ...people,
    roleMembers: new Map([...people.roleMembers, ['operations_head', ['ops-1']]]),
    departmentHeads: new Map([
      ['dept-1', 'head-1'],
      ['dept-2', 'head-2'],
    ]),
    activeUserIds: new Set(['head-1']),
  };
  const headDir = (data: DirectoryData = heads, sodUserIds: string[] = []) =>
    buildDirectory(data, { now: NOW, documentType: 'purchase_request', sodUserIds });

  it('defaults fallbackRole to operations_head and needs no target field', () => {
    expect(headSpec().steps[0]).toMatchObject({
      kind: 'department_head',
      fallbackRole: 'operations_head',
    });
    expect(headSpec({ fallbackRole: 'finance' }).steps[0]).toMatchObject({
      fallbackRole: 'finance',
    });
  });

  it("plans the head of the request's department as the approver", () => {
    const plan = route(headSpec(), { departmentId: 'dept-1' }, headDir(), ['req-1']);
    expect(plan.blocked).toBe(false);
    expect(plan.steps[0]).toEqual({
      seq: 1,
      kind: 'department_head',
      userId: 'head-1',
      reason: 'Department head approval',
      eligibleUserIds: ['head-1'],
      blocked: false,
    });
  });

  it("adds the head's active delegate, like a user step", () => {
    const d = headDir({
      ...heads,
      delegations: [
        {
          fromUserId: 'head-1',
          toUserId: 'deputy-9',
          startsAt: new Date('2026-11-01T00:00:00Z'),
          endsAt: new Date('2026-11-10T00:00:00Z'),
          documentType: null,
          revokedAt: null,
        },
      ],
    });
    expect(route(headSpec(), { departmentId: 'dept-1' }, d, []).steps[0]).toMatchObject({
      userId: 'head-1',
      eligibleUserIds: ['head-1', 'deputy-9'],
    });
  });

  it.each([
    ['the head is the requester (in sodUserIds)', { departmentId: 'dept-1' }, ['head-1']],
    ['the department has no head', { departmentId: 'dept-none' }, []],
    ['the head is not an active member of the entity', { departmentId: 'dept-2' }, []],
    ['the request names no department', {}, []],
    ['the departmentId fact is not a string', { departmentId: 42 }, []],
  ])('falls back to operations_head when %s', (_label, facts, sod) => {
    const plan = route(headSpec(), facts, headDir(heads, sod), sod);
    expect(plan.blocked).toBe(false);
    expect(plan.steps[0]).toEqual({
      seq: 1,
      kind: 'department_head',
      roleKey: 'operations_head',
      reason: 'Department head approval',
      eligibleUserIds: ['ops-1'],
      blocked: false,
    });
  });

  it('falls back to the configured fallbackRole', () => {
    const plan = route(headSpec({ fallbackRole: 'management' }), {}, headDir(), []);
    expect(plan.steps[0]).toMatchObject({ roleKey: 'management', eligibleUserIds: ['mgmt-1'] });
  });

  it('never lets the requester approve as the fallback either', () => {
    const plan = route(headSpec(), { departmentId: 'dept-1' }, headDir(heads, ['head-1']), [
      'head-1',
    ]);
    expect(plan.steps[0]?.eligibleUserIds).not.toContain('head-1');
  });

  it('blocks the plan when the head falls back and the fallback role is empty', () => {
    const data = { ...heads, roleMembers: people.roleMembers };
    const plan = route(headSpec(), { departmentId: 'dept-1' }, headDir(data, ['head-1']), [
      'head-1',
    ]);
    expect(plan.steps[0]).toMatchObject({
      kind: 'department_head',
      roleKey: 'operations_head',
      eligibleUserIds: [],
      blocked: true,
    });
    expect(plan.blocked).toBe(true);
    expect(plan.blockReason).toBe(
      'Step 1 (department head, fallback role operations_head) has no eligible approver after separation of duties',
    );
  });

  it('leaves the other step kinds untouched by a department-head directory', () => {
    expect(route(seedSpec, { amountNpr: '10' }, headDir(), []).steps).toEqual(
      route(seedSpec, { amountNpr: '10' }, dir, []).steps,
    );
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

describe('route: distinct approvers must exist at plan time (AD8)', () => {
  // Under distinctApprovers one person decides at most one step, so the plan is blocked unless every
  // open step can get its own person; otherwise it would stick after the first decision.
  const spec = (steps: { id: string; role: string }[], distinctApprovers = true) =>
    WorkflowSpecSchema.parse({
      documentType: 'x',
      distinctApprovers,
      steps: steps.map((s) => ({ ...s, kind: 'role', reason: s.id })),
    });
  const twoManagement = spec([
    { id: 'm1', role: 'management' },
    { id: 'm2', role: 'management' },
  ]);
  const dirWith = (
    roleMembers: [string, string[]][],
    delegations: DirectoryData['delegations'] = [],
  ) =>
    buildDirectory(
      { roleMembers: new Map(roleMembers), groups: new Map(), delegations },
      { now: NOW, documentType: 'x' },
    );

  it('blocks two Management steps with one Management user', () => {
    const plan = route(twoManagement, {}, dirWith([['management', ['mgmt-1']]]), []);
    expect(plan.steps.map((s) => s.blocked)).toEqual([false, true]);
    expect(plan.steps[1]?.eligibleUserIds).toEqual(['mgmt-1']);
    expect(plan.blocked).toBe(true);
    expect(plan.blockReason).toBe(
      "Step 2 (role management) has no eligible approver distinct from the other steps' approvers",
    );
  });

  it('plans two Management steps with two Management users', () => {
    const plan = route(twoManagement, {}, dirWith([['management', ['mgmt-1', 'mgmt-2']]]), []);
    expect(plan.blocked).toBe(false);
    expect(plan.steps.map((s) => s.blocked)).toEqual([false, false]);
  });

  it('blocks mixed roles when one person holds both and is the only candidate for both', () => {
    const plan = route(
      spec([
        { id: 'a', role: 'accountant' },
        { id: 'f', role: 'finance' },
      ]),
      {},
      dirWith([
        ['accountant', ['u-1']],
        ['finance', ['u-1']],
      ]),
      [],
    );
    expect(plan.blocked).toBe(true);
    expect(plan.blockReason).toBe(
      "Step 2 (role finance) has no eligible approver distinct from the other steps' approvers",
    );
  });

  it('finds an assignment a greedy pick would miss (augmenting path)', () => {
    // Step 1 may take u-1 or u-2, step 2 only u-1: step 1 must give u-1 up.
    const plan = route(
      spec([
        { id: 'a', role: 'accountant' },
        { id: 'f', role: 'finance' },
      ]),
      {},
      dirWith([
        ['accountant', ['u-1', 'u-2']],
        ['finance', ['u-1']],
      ]),
      [],
    );
    expect(plan.blocked).toBe(false);
  });

  it('counts a delegate as a distinct person', () => {
    const plan = route(
      twoManagement,
      {},
      dirWith(
        [['management', ['mgmt-1']]],
        [
          {
            fromUserId: 'mgmt-1',
            toUserId: 'deputy-1',
            startsAt: new Date('2026-11-01T00:00:00Z'),
            endsAt: new Date('2026-11-30T00:00:00Z'),
            documentType: null,
            revokedAt: null,
          },
        ],
      ),
      [],
    );
    expect(plan.blocked).toBe(false);
  });

  it('leaves the plan unblocked when distinctApprovers is off', () => {
    const plan = route(
      spec(
        [
          { id: 'm1', role: 'management' },
          { id: 'm2', role: 'management' },
        ],
        false,
      ),
      {},
      dirWith([['management', ['mgmt-1']]]),
      [],
    );
    expect(plan.blocked).toBe(false);
    expect(plan.steps.map((s) => s.eligibleUserIds)).toEqual([['mgmt-1'], ['mgmt-1']]);
  });

  it('keeps the separation-of-duties reason when a step is empty', () => {
    const plan = route(twoManagement, {}, dirWith([['management', ['mgmt-1']]]), ['mgmt-1']);
    expect(plan.blockReason).toBe(
      'Step 1 (role management) has no eligible approver after separation of duties',
    );
  });

  it('leaves decided steps out: their decider is already kept off the later steps', () => {
    // u-1 decided step 1 and has since left accountant; step 1 must not take u-2 away from step 2.
    const plan = route(
      spec([
        { id: 'a', role: 'accountant' },
        { id: 'f', role: 'finance' },
      ]),
      {},
      dirWith([
        ['accountant', ['u-2']],
        ['finance', ['u-1', 'u-2']],
      ]),
      [],
      [{ seq: 1, deciders: ['u-1'] }],
    );
    expect(plan.blocked).toBe(false);
    expect(plan.steps[1]?.eligibleUserIds).toEqual(['u-2']);
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

describe('route: an amount after a currency code in a reason reads as money (U15b-Q7)', () => {
  const amountSpec = (reason: string): WorkflowSpec =>
    WorkflowSpecSchema.parse({
      documentType: 'vendor_bill',
      steps: [{ id: 'finance', kind: 'role', role: 'finance', reason: 'Finance' }],
      rules: [
        {
          id: 'founder',
          when: { field: 'amountNpr', op: 'gt', value: '1000000' },
          add: { id: 'founder', kind: 'role', role: 'founder', reason: 'Founder' },
          position: 'end',
          reason,
        },
      ],
    });
  const reasonOf = (reason: string, facts: Record<string, unknown>) =>
    route(amountSpec(reason), facts, dir, []).steps[1]?.reason;
  const billReason = 'Non-PO bill of NPR {amountNpr} is above NPR 1,000,000.00';

  it('groups the digits and keeps two decimals, as the limit beside it is written', () => {
    expect(reasonOf(billReason, { amountNpr: '139506172.14' })).toBe(
      'Non-PO bill of NPR 139,506,172.14 is above NPR 1,000,000.00',
    );
    expect(reasonOf(billReason, { amountNpr: '1000000.1' })).toBe(
      'Non-PO bill of NPR 1,000,000.10 is above NPR 1,000,000.00',
    );
  });

  it('rounds an unrounded fact half up to two decimals in the text only (D22)', () => {
    const facts = { amountNpr: '1234567.125' };
    expect(reasonOf(billReason, facts)).toBe(
      'Non-PO bill of NPR 1,234,567.13 is above NPR 1,000,000.00',
    );
    expect(facts.amountNpr).toBe('1234567.125');
    expect(reasonOf('Paid USD {amount} today', { amountNpr: '2000000', amount: 1500000.5 })).toBe(
      'Paid USD 1,500,000.50 today',
    );
  });

  it('leaves a placeholder without a currency code, or an unknown one, as before', () => {
    expect(reasonOf('Total {amountNpr} in NPR', { amountNpr: '1500000.00' })).toBe(
      'Total 1500000.00 in NPR',
    );
    expect(reasonOf('Bill of NPR {missing}', { amountNpr: '1500000.00' })).toBe(
      'Bill of NPR {missing}',
    );
    expect(reasonOf('Bill of NPR {note}', { amountNpr: '1500000.00', note: 'n/a' })).toBe(
      'Bill of NPR n/a',
    );
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

  it('renders a number and a long decimal without exponent', () => {
    expect(reasonOf({ effectiveDiscountPct: 12.0001 })).toBe(
      'Discount 12.0001% exceeds permitted 12%',
    );
    expect(reasonOf({ effectiveDiscountPct: 1e21 })).toBe(
      'Discount 1000000000000000000000% exceeds permitted 12%',
    );
  });

  it('rounds a percentage placeholder ("{fact}%") half up to four decimals (D22)', () => {
    // The pricing fact is unrounded (discount x 100 / subtotal), e.g. 100/7 % of a subtotal.
    expect(reasonOf({ effectiveDiscountPct: '14.285714285714285714' })).toBe(
      'Discount 14.2857% exceeds permitted 12%',
    );
    expect(reasonOf({ effectiveDiscountPct: '12.33335' })).toBe(
      'Discount 12.3334% exceeds permitted 12%',
    );
    expect(reasonOf({ effectiveDiscountPct: 12.33335 })).toBe(
      'Discount 12.3334% exceeds permitted 12%',
    );
    // Accepted: a share just above the limit keeps its four zeros rather than reading "12%".
    expect(reasonOf({ effectiveDiscountPct: '12.000000000000000000001' })).toBe(
      'Discount 12.0000% exceeds permitted 12%',
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

  it('leaves a value that is not followed by % at its written scale', () => {
    expect(
      loose('Discount of {effectiveDiscountPct} percent', { effectiveDiscountPct: '12.33335' }),
    ).toBe('Discount of 12.33335 percent');
  });

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
