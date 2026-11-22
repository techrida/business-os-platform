import { MEMO_APPROVER_DEFAULT_SPEC, WorkflowSpecSchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  describeCondition,
  describeStepTarget,
  emptyRule,
  emptySpecForm,
  formToSpec,
  parseSpecJson,
  specToForm,
} from './spec-form';

// The shape of the seed's test_memo v1 (plan §6.2 U8), as the API stores it after parsing.
const seedSpec = WorkflowSpecSchema.parse({
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
      add: { id: 'management', kind: 'role', role: 'management', reason: 'Over NPR 1,00,000' },
      position: 'end',
      reason: 'Over NPR 1,00,000',
    },
    {
      id: 'over-10-lakh',
      when: { field: 'amountNpr', op: 'gt', value: '1000000' },
      add: {
        id: 'founder',
        kind: 'role',
        role: 'founder',
        reason: 'Founder approval because NPR equivalent exceeds 10,00,000',
      },
      position: { after: 'finance' },
      reason: 'Founder approval because NPR equivalent exceeds 10,00,000',
    },
  ],
});

describe('specToForm and formToSpec', () => {
  it('round-trips the seed spec without losing or changing anything', () => {
    const converted = specToForm(seedSpec);
    expect(converted.ok).toBe(true);
    if (!converted.ok) return;
    const built = formToSpec(converted.form);
    expect(built).toEqual({ ok: true, spec: seedSpec });
  });

  it('writes an existing numeric threshold as exact decimal text', () => {
    const spec = WorkflowSpecSchema.parse({
      ...seedSpec,
      rules: [
        {
          id: 'r',
          when: { field: 'amountNpr', op: 'gte', value: 500 },
          add: { id: 'm', kind: 'role', role: 'management', reason: 'x' },
          reason: 'x',
        },
      ],
    });
    const converted = specToForm(spec);
    if (!converted.ok) throw new Error('should convert');
    const built = formToSpec(converted.form);
    expect(built.ok && built.spec.rules[0]?.when).toEqual({
      field: 'amountNpr',
      op: 'gte',
      value: '500',
    });
  });

  it('rejects a fractional paisa and keeps a valid amount as text', () => {
    const converted = specToForm(seedSpec);
    if (!converted.ok) throw new Error('should convert');
    const rule = converted.form.rules[0]!;
    rule.value = '1.005';
    expect(formToSpec(converted.form)).toMatchObject({
      ok: false,
      issues: ['rules[1].when.value: Enter an amount with up to two decimal places.'],
    });
    rule.value = '1.01';
    expect(formToSpec(converted.form)).toMatchObject({
      ok: true,
      spec: { rules: [{ when: { value: '1.01' } }, {}] },
    });
  });

  it('refuses a negative amount and says it must be zero or more', () => {
    const converted = specToForm(seedSpec);
    if (!converted.ok) throw new Error('should convert');
    converted.form.rules[0]!.value = '-100';
    expect(formToSpec(converted.form)).toMatchObject({
      ok: false,
      issues: ['rules[1].when.value: Enter an amount of zero or more.'],
    });
  });

  it('reads a stored 100000.000 as 100000, so the round trip passes the amount check', () => {
    const spec = WorkflowSpecSchema.parse({
      ...seedSpec,
      rules: [
        { ...seedSpec.rules[0]!, when: { field: 'amountNpr', op: 'gt', value: '100000.000' } },
      ],
    });
    const converted = specToForm(spec);
    if (!converted.ok) throw new Error('should convert');
    expect(converted.form.rules[0]!.value).toBe('100000');
    expect(formToSpec(converted.form)).toMatchObject({
      ok: true,
      spec: { rules: [{ when: { value: '100000' } }] },
    });
  });

  it('refuses to flatten a rule the form cannot show (nested all, other field)', () => {
    const nested = WorkflowSpecSchema.parse({
      ...seedSpec,
      rules: [
        {
          id: 'both',
          when: {
            all: [
              { field: 'amountNpr', op: 'gt', value: '1' },
              { field: 'currency', op: 'eq', value: 'USD' },
            ],
          },
          add: { id: 'm', kind: 'role', role: 'management', reason: 'x' },
          reason: 'x',
        },
        {
          id: 'currency',
          when: { field: 'currency', op: 'in', value: ['USD', 'INR'] },
          add: { id: 'f', kind: 'role', role: 'founder', reason: 'x' },
          reason: 'x',
        },
      ],
    });
    const converted = specToForm(nested);
    expect(converted.ok).toBe(false);
    if (converted.ok) return;
    expect(converted.reasons).toHaveLength(2);
    expect(converted.reasons[0]).toContain('both');
  });

  it('supports group and user steps', () => {
    const spec = WorkflowSpecSchema.parse({
      ...seedSpec,
      steps: [
        { id: 'g', kind: 'group', group: 'ops', reason: 'x' },
        { id: 'u', kind: 'user', user: 'abc', reason: 'y' },
      ],
      rules: [],
    });
    const converted = specToForm(spec);
    if (!converted.ok) throw new Error('should convert');
    expect(converted.form.steps.map((s) => s.target)).toEqual(['ops', 'abc']);
    expect(formToSpec(converted.form)).toEqual({ ok: true, spec });
  });

  it('round-trips a department_head step with its fallback role, as a step and as a rule step', () => {
    const spec = WorkflowSpecSchema.parse({
      ...seedSpec,
      steps: [
        { id: 'head', kind: 'department_head', fallbackRole: 'management', reason: 'Head signs' },
        { id: 'finance', kind: 'role', role: 'finance', reason: 'Finance approves' },
      ],
      rules: [
        {
          id: 'big',
          when: { field: 'amountNpr', op: 'gt', value: '100000' },
          add: { id: 'big-head', kind: 'department_head', reason: 'Head again' },
          position: 'end',
          reason: 'Big',
        },
      ],
    });
    const converted = specToForm(spec);
    if (!converted.ok) throw new Error('should convert');
    expect(converted.form.steps[0]).toMatchObject({
      kind: 'department_head',
      target: 'management',
    });
    // The schema fills in operations_head when the spec names no fallback.
    expect(converted.form.rules[0]?.step).toMatchObject({
      kind: 'department_head',
      target: 'operations_head',
    });
    const built = formToSpec(converted.form);
    expect(built).toEqual({ ok: true, spec });
    if (!built.ok) return;
    expect(built.spec.steps[0]).toEqual({
      id: 'head',
      kind: 'department_head',
      fallbackRole: 'management',
      reason: 'Head signs',
    });
    expect(built.spec.steps[0]).not.toHaveProperty('department_head');
  });

  it('builds a department_head step from the form with no target typed in', () => {
    const form = emptySpecForm('test_memo');
    form.steps = [
      { id: 'head', kind: 'department_head', target: 'operations_head', reason: 'Head signs' },
    ];
    const built = formToSpec(form);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.spec.steps[0]).toMatchObject({
      kind: 'department_head',
      fallbackRole: 'operations_head',
    });
  });

  it('keeps a spec with a stray field on a department_head step in JSON', () => {
    const converted = specToForm({
      ...seedSpec,
      steps: [
        {
          id: 'head',
          kind: 'department_head',
          fallbackRole: 'operations_head',
          role: 'finance',
          reason: 'x',
        },
      ],
      rules: [],
    });
    expect(converted.ok).toBe(false);
    if (converted.ok) return;
    expect(converted.reasons[0]).toContain('role');
  });

  it('describes a department_head step for the read-only view', () => {
    expect(
      describeStepTarget({
        id: 'head',
        kind: 'department_head',
        fallbackRole: 'management',
        reason: 'x',
      }),
    ).toBe('department head (falls back to management)');
  });
});

describe('emptySpecForm', () => {
  it('starts from the built-in default times when none are given', () => {
    const form = emptySpecForm('test_memo');
    expect([form.remindAfterHours, form.escalateAfterHours, form.escalateRole]).toEqual([
      '24',
      '72',
      'founder',
    ]);
  });

  it('starts from the saved default times it is given', () => {
    const form = emptySpecForm('test_memo', {
      remindAfterHours: 8,
      escalateAfterHours: 36,
      escalateTo: { role: 'management' },
    });
    expect([form.remindAfterHours, form.escalateAfterHours, form.escalateRole]).toEqual([
      '8',
      '36',
      'management',
    ]);
  });
});

describe('formToSpec validation', () => {
  it('reports readable issues for an empty reason and a bad SLA', () => {
    const form = emptySpecForm('test_memo');
    form.escalateAfterHours = '10';
    const built = formToSpec(form);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.issues.some((i) => i.startsWith('steps[1].reason'))).toBe(true);
    expect(built.issues.some((i) => i.includes('later than remindAfterHours'))).toBe(true);
  });

  it('new rows get ids that do not clash with existing steps', () => {
    const form = emptySpecForm('test_memo');
    const rule = emptyRule(
      form.steps.map((s) => s.id),
      0,
    );
    expect(rule.id).toBe('rule-1');
    expect(form.steps.map((s) => s.id)).not.toContain(rule.step.id);
  });
});

describe('parseSpecJson', () => {
  it('accepts a valid spec and rejects broken JSON and an invalid spec', () => {
    expect(parseSpecJson(JSON.stringify(seedSpec))).toEqual({ ok: true, spec: seedSpec });
    expect(parseSpecJson('{').ok).toBe(false);
    const bad = parseSpecJson(
      '{"documentType":"x","steps":[{"id":"a","kind":"role","reason":"r"}]}',
    );
    expect(bad.ok).toBe(false);
  });
});

describe('describeCondition', () => {
  it('prints leaves and nested groups in plain words', () => {
    expect(describeCondition({ field: 'amountNpr', op: 'gt', value: '100000' })).toBe(
      'amountNpr > 100000',
    );
    expect(
      describeCondition({
        any: [
          { field: 'currency', op: 'in', value: ['USD', 'INR'] },
          { all: [{ field: 'amountNpr', op: 'lte', value: 5 }] },
        ],
      }),
    ).toBe('(currency in [USD, INR] or (amountNpr <= 5))');
  });
});

describe('describeStepTarget', () => {
  it('uses names for people and groups and never exposes a missing target id', () => {
    const user = { id: 'review', kind: 'user' as const, user: 'opaque-user', reason: 'Review' };
    const group = { id: 'review', kind: 'group' as const, group: 'opaque-group', reason: 'Review' };
    expect(describeStepTarget(user, { 'opaque-user': 'Mina' })).toBe('Person: Mina');
    expect(describeStepTarget(group, {}, { 'opaque-group': 'Reviewers' })).toBe('Group: Reviewers');
    expect(describeStepTarget(user)).toBe('Person: Name unavailable');
    expect(describeStepTarget(group)).toBe('Group: Name unavailable');
  });

  it('keeps the incoming role label alongside the department-head fallback label', () => {
    expect(
      describeStepTarget({ id: 'review', kind: 'role', role: 'finance', reason: 'Review' }),
    ).toBe('Role: finance');
    expect(describeStepTarget({ id: 'head', kind: 'department_head', reason: 'Review' })).toBe(
      'department head (falls back to operations_head)',
    );
  });
});

describe('the seeded Memo approver workflow (F1-Q9)', () => {
  it('opens in the form, so Settings > Workflows edits it without the JSON editor', () => {
    const converted = specToForm(WorkflowSpecSchema.parse(MEMO_APPROVER_DEFAULT_SPEC));
    expect(converted.ok).toBe(true);
  });
});

// The tax_invoice routes (F1-Q30), copied word for word: the original from migration 0110's `v_old`, the new one
// from tools/seed-zitadel/src/db-seed.ts TAX_INVOICE_WORKFLOW_SPEC and migration 0110's `v_new`. The workspace does
// not depend on the seed package, so they are not imported; keep them in step with those two files.
const ORIGINAL_TAX_INVOICE_WORKFLOW_SPEC = {
  documentType: 'tax_invoice',
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: 'Base route: accountant checks the tax invoice',
    },
    { id: 'finance', kind: 'role', role: 'finance', reason: 'Base route: finance approves' },
  ],
  rules: [],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
};
const TAX_INVOICE_WORKFLOW_SPEC = {
  documentType: 'tax_invoice',
  steps: [],
  rules: [
    {
      id: 'manual-invoice',
      when: { field: 'fromSchedule', op: 'eq', value: false },
      add: {
        id: 'accountant',
        kind: 'role',
        role: 'accountant',
        reason: 'Accountant checks a manual tax invoice',
      },
      position: 'end',
      reason: 'Accountant check: a manual invoice, not from an approved billing schedule',
    },
    {
      id: 'finance-approves',
      when: { field: 'kind', op: 'eq', value: 'tax_invoice' },
      add: {
        id: 'finance',
        kind: 'role',
        role: 'finance',
        reason: 'Finance approves every tax invoice',
      },
      position: 'end',
      reason: 'Finance approves every tax invoice',
    },
  ],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
};

describe('the tax invoice route (U23-Q4, F1-Q30)', () => {
  it.each([
    ['the original route', ORIGINAL_TAX_INVOICE_WORKFLOW_SPEC],
    ['the route from migration 0110', TAX_INVOICE_WORKFLOW_SPEC],
  ])('%s opens in the form and saves back identical', (_name, raw) => {
    const converted = specToForm(WorkflowSpecSchema.parse(raw));
    if (!converted.ok) throw new Error(converted.reasons.join('; '));
    const built = formToSpec(converted.form);
    if (!built.ok) throw new Error(built.issues.join('; '));
    expect(built.spec).toEqual(raw);
    // Byte for byte, so a boolean false never comes back as the text "false".
    expect(JSON.stringify(built.spec)).toBe(JSON.stringify(raw));
  });

  it('shows the billing-schedule and document-type conditions as facts, not as amounts', () => {
    const converted = specToForm(WorkflowSpecSchema.parse(TAX_INVOICE_WORKFLOW_SPEC));
    if (!converted.ok) throw new Error('should convert');
    expect(converted.form.steps).toEqual([]);
    expect(converted.form.rules.map((r) => r.fact)).toEqual([
      { field: 'fromSchedule', value: false },
      { field: 'kind', value: 'tax_invoice' },
    ]);
  });

  it('writes a changed billing-schedule condition as a boolean', () => {
    const converted = specToForm(WorkflowSpecSchema.parse(TAX_INVOICE_WORKFLOW_SPEC));
    if (!converted.ok) throw new Error('should convert');
    const [manual, every] = converted.form.rules;
    if (!manual || !every) throw new Error('two rules');
    const built = formToSpec({
      ...converted.form,
      rules: [{ ...manual, fact: { field: 'fromSchedule', value: true } }, every],
    });
    expect(built.ok && built.spec.rules[0]?.when).toEqual({
      field: 'fromSchedule',
      op: 'eq',
      value: true,
    });
  });

  it.each([
    [
      'fromSchedule compared with the text "false"',
      { field: 'fromSchedule', op: 'eq', value: 'false' },
    ],
    ['fromSchedule with neq', { field: 'fromSchedule', op: 'neq', value: false }],
    ['kind compared with a number', { field: 'kind', op: 'eq', value: 1 }],
    ['kind with in', { field: 'kind', op: 'in', value: ['tax_invoice'] }],
    ['kind with neq', { field: 'kind', op: 'neq', value: 'credit_note' }],
    ['a field the form does not know', { field: 'currency', op: 'eq', value: 'USD' }],
  ])('keeps a rule on %s in JSON', (_name, when) => {
    const spec = WorkflowSpecSchema.parse({
      ...TAX_INVOICE_WORKFLOW_SPEC,
      rules: [{ ...TAX_INVOICE_WORKFLOW_SPEC.rules[0], when }],
    });
    const converted = specToForm(spec);
    expect(converted.ok).toBe(false);
    if (converted.ok) return;
    expect(converted.reasons).toHaveLength(1);
    expect(converted.reasons[0]).toContain('manual-invoice');
  });

  it('starts a new rule as an amount threshold, never a fact a submit may not send', () => {
    expect(emptyRule([], 0).fact).toBeUndefined();
  });
});
