// Converts between the workflow editor's form state and a WorkflowSpec. Serves the NFR "approvals are
// auditable": whatever the form builds is validated with WorkflowWriteSpecSchema before it is sent, and a
// spec the form cannot show faithfully (nested all/any, a field other than amountNpr or the two facts in
// FactCondition) is never flattened: the editor falls back to raw JSON for it, so saving a draft never drops a rule.
import {
  DEFAULT_DEPARTMENT_HEAD_FALLBACK_ROLE,
  MONEY_LIMITS,
  ROLE_KEYS,
  SETTING_DEFAULTS,
  WorkflowWriteSpecSchema,
  type Condition,
  type RoleKey,
  type StepKind,
  type StepSpec,
  type WorkflowSpec,
} from '@bos/contracts';

import { withoutTrailingZeros } from '../format';

/** The one field the threshold rows can test. Other fields stay in the JSON editor. */
export const THRESHOLD_FIELD = 'amountNpr';
export const THRESHOLD_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'] as const;
export type ThresholdOp = (typeof THRESHOLD_OPS)[number];

export const OP_LABEL: Record<ThresholdOp, string> = {
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  eq: 'equals',
  neq: 'does not equal',
};

export interface StepForm {
  id: string;
  kind: StepKind;
  /** The role key, group key or user id, depending on `kind`; a department head's fallback role. */
  target: string;
  reason: string;
}

/**
 * A saved rule that tests a submit fact instead of the amount, in the one shape the form can write back exactly
 * (U23-Q4). The tax invoice route (migration 0110, F1-Q30) uses both: `fromSchedule` equal to a boolean (the invoice
 * was drafted from an approved billing schedule line) and `kind` equal to the document type (every request). New rules
 * are never facts: a submit that does not send the fact fails the condition, so only saved rules carry one.
 */
export type FactCondition =
  { field: 'fromSchedule'; value: boolean } | { field: 'kind'; value: string };

export interface RuleForm {
  id: string;
  /** For an amount rule; ignored when `fact` is set. */
  op: ThresholdOp;
  /** For an amount rule; ignored when `fact` is set. */
  value: string;
  /** Set when the rule tests a submit fact instead of the amount. */
  fact?: FactCondition;
  step: StepForm;
  /** Id of the step this one goes after; '' means at the end. */
  afterStepId: string;
  reason: string;
}

export interface SpecForm {
  documentType: string;
  distinctApprovers: boolean;
  remindAfterHours: string;
  escalateAfterHours: string;
  escalateRole: RoleKey;
  steps: StepForm[];
  rules: RuleForm[];
}

export type FormConversion = { ok: true; form: SpecForm } | { ok: false; reasons: string[] };
export type SpecBuild = { ok: true; spec: WorkflowSpec } | { ok: false; issues: string[] };

/** The kinds whose target is a field of the same name on the step. */
const NAMED_KINDS = ['role', 'group', 'user'] as const;

export function nextId(prefix: string, taken: readonly string[]): string {
  let n = taken.length + 1;
  while (taken.includes(`${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

export function emptyStep(taken: readonly string[]): StepForm {
  return { id: nextId('step', taken), kind: 'role', target: ROLE_KEYS[0], reason: '' };
}

export function emptyRule(taken: readonly string[], ruleCount: number): RuleForm {
  const id = nextId(
    'rule',
    Array.from({ length: ruleCount }, (_, i) => `rule-${i + 1}`),
  );
  const stepId = taken.includes(`${id}-step`) ? nextId(`${id}-step`, taken) : `${id}-step`;
  return {
    id,
    op: 'gt',
    value: '',
    step: { id: stepId, kind: 'role', target: 'management', reason: '' },
    afterStepId: '',
    reason: '',
  };
}

/**
 * A new workflow starts from the saved default reminder and escalation times (`approvals.sla_defaults`),
 * so what the form shows is what a workflow that sets no times of its own would get. The built-in
 * default stands in when the saved value could not be read.
 */
export function emptySpecForm(
  documentType = '',
  sla: WorkflowSpec['sla'] = SETTING_DEFAULTS['approvals.sla_defaults'],
): SpecForm {
  return {
    documentType,
    distinctApprovers: true,
    remindAfterHours: String(sla.remindAfterHours),
    escalateAfterHours: String(sla.escalateAfterHours),
    escalateRole: sla.escalateTo.role,
    steps: [emptyStep([])],
    rules: [],
  };
}

function stepToForm(step: StepSpec): StepForm | string {
  // A step that carries a field for another kind would lose it in the form.
  const stray: string[] = NAMED_KINDS.filter((k) => k !== step.kind && step[k] !== undefined);
  if (step.kind !== 'department_head' && step.fallbackRole !== undefined) {
    stray.push('fallbackRole');
  }
  if (stray.length > 0) return `step "${step.id}" also sets ${stray.join(', ')}`;
  const target =
    step.kind === 'department_head'
      ? (step.fallbackRole ?? DEFAULT_DEPARTMENT_HEAD_FALLBACK_ROLE)
      : (step[step.kind] ?? '');
  return { id: step.id, kind: step.kind, target, reason: step.reason };
}

/** Null when `when` is not a single amountNpr comparison the form can show. */
function thresholdOf(when: Condition): { op: ThresholdOp; value: string } | null {
  if (!('field' in when) || when.field !== THRESHOLD_FIELD) return null;
  if (when.op === 'in') return null;
  if (typeof when.value !== 'string' && typeof when.value !== 'number') return null;
  return { op: when.op, value: withoutTrailingZeros(String(when.value), MONEY_LIMITS.scale) };
}

/** Null unless `when` is exactly a FactCondition: `fromSchedule` eq a boolean, or `kind` eq a string. */
function factOf(when: Condition): FactCondition | null {
  if (!('field' in when) || when.op !== 'eq') return null;
  if (when.field === 'fromSchedule' && typeof when.value === 'boolean') {
    return { field: 'fromSchedule', value: when.value };
  }
  if (when.field === 'kind' && typeof when.value === 'string') {
    return { field: 'kind', value: when.value };
  }
  return null;
}

/** Whether the spec fits the form without loss. If not, `reasons` says why (shown above the JSON). */
export function specToForm(spec: WorkflowSpec): FormConversion {
  const reasons: string[] = [];
  const steps: StepForm[] = [];
  for (const s of spec.steps) {
    const converted = stepToForm(s);
    if (typeof converted === 'string') reasons.push(converted);
    else steps.push(converted);
  }

  const rules: RuleForm[] = [];
  for (const r of spec.rules) {
    const fact = factOf(r.when);
    const threshold = fact ? { op: 'eq' as const, value: '' } : thresholdOf(r.when);
    if (!threshold) {
      reasons.push(
        `rule "${r.id}" tests something other than a single ${THRESHOLD_FIELD} comparison`,
      );
      continue;
    }
    const step = stepToForm(r.add);
    if (typeof step === 'string') {
      reasons.push(`rule "${r.id}": ${step}`);
      continue;
    }
    rules.push({
      id: r.id,
      op: threshold.op,
      value: threshold.value,
      ...(fact ? { fact } : {}),
      step,
      afterStepId: r.position === 'end' ? '' : r.position.after,
      reason: r.reason,
    });
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return {
    ok: true,
    form: {
      documentType: spec.documentType,
      distinctApprovers: spec.distinctApprovers,
      remindAfterHours: String(spec.sla.remindAfterHours),
      escalateAfterHours: String(spec.sla.escalateAfterHours),
      escalateRole: spec.sla.escalateTo.role,
      steps,
      rules,
    },
  };
}

function formatIssues(issues: readonly { path: PropertyKey[]; message: string }[]): string[] {
  return issues.map((i) => {
    const where = i.path
      .map((p, n) => (typeof p === 'number' ? `[${p + 1}]` : n === 0 ? String(p) : `.${String(p)}`))
      .join('');
    return where === '' ? i.message : `${where}: ${i.message}`;
  });
}

/** A department_head step names no person or group, only the role it falls back to. */
const stepFromForm = (s: StepForm) => ({
  id: s.id.trim(),
  kind: s.kind,
  [s.kind === 'department_head' ? 'fallbackRole' : s.kind]: s.target.trim(),
  reason: s.reason.trim(),
});

/** Builds the spec from the form and validates it; the issues are worded for the admin. */
export function formToSpec(form: SpecForm): SpecBuild {
  const draft = {
    documentType: form.documentType.trim(),
    steps: form.steps.map(stepFromForm),
    rules: form.rules.map((r) => ({
      id: r.id.trim(),
      when: r.fact
        ? { field: r.fact.field, op: 'eq', value: r.fact.value }
        : { field: THRESHOLD_FIELD, op: r.op, value: r.value.trim() },
      add: stepFromForm(r.step),
      position: r.afterStepId.trim() === '' ? 'end' : { after: r.afterStepId.trim() },
      reason: r.reason.trim(),
    })),
    distinctApprovers: form.distinctApprovers,
    sla: {
      remindAfterHours: Number(form.remindAfterHours),
      escalateAfterHours: Number(form.escalateAfterHours),
      escalateTo: { role: form.escalateRole },
    },
  };
  const parsed = WorkflowWriteSpecSchema.safeParse(draft);
  return parsed.success
    ? { ok: true, spec: parsed.data }
    : { ok: false, issues: formatIssues(parsed.error.issues) };
}

/** The advanced editor: text in, validated spec out. */
export function parseSpecJson(text: string): SpecBuild {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, issues: ['The text is not valid JSON.'] };
  }
  const parsed = WorkflowWriteSpecSchema.safeParse(json);
  return parsed.success
    ? { ok: true, spec: parsed.data }
    : { ok: false, issues: formatIssues(parsed.error.issues) };
}

// ---------------------------------------------------------------------------------------------
// Plain-language text for read-only views
// ---------------------------------------------------------------------------------------------

const OP_SYMBOL: Record<string, string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '=',
  neq: '!=',
  in: 'in',
};

export function describeCondition(c: Condition): string {
  if ('all' in c) return `(${c.all.map(describeCondition).join(' and ')})`;
  if ('any' in c) return `(${c.any.map(describeCondition).join(' or ')})`;
  const value = Array.isArray(c.value) ? `[${c.value.join(', ')}]` : String(c.value);
  return `${c.field} ${OP_SYMBOL[c.op] ?? c.op} ${value}`;
}

export function describeStepTarget(
  step: StepSpec,
  people: Record<string, string> = {},
  groups: Record<string, string> = {},
): string {
  if (step.kind === 'department_head') {
    return `department head (falls back to ${step.fallbackRole ?? DEFAULT_DEPARTMENT_HEAD_FALLBACK_ROLE})`;
  }
  if (step.kind === 'user') return `Person: ${people[step.user ?? ''] ?? 'Name unavailable'}`;
  if (step.kind === 'group') return `Group: ${groups[step.group ?? ''] ?? 'Name unavailable'}`;
  return `Role: ${step.role ?? '(missing)'}`;
}
