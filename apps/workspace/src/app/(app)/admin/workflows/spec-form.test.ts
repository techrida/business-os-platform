import { WorkflowSpecSchema } from '@bos/contracts';
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

  it('keeps a numeric threshold value a number', () => {
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
      value: 500,
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
