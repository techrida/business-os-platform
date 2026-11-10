// Converts between the workflow editor's form state and a WorkflowSpec. Serves the NFR "approvals are
// auditable": whatever the form builds is validated with WorkflowSpecSchema before it is sent, and a
// spec the form cannot show faithfully (nested all/any, a field other than amountNpr) is never
// flattened: the editor falls back to raw JSON for it, so saving a draft never drops a rule.
import {
  ROLE_KEYS,
  WorkflowSpecSchema,
  type Condition,
  type RoleKey,
  type StepKind,
  type StepSpec,
  type WorkflowSpec,
} from '@bos/contracts';

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
  /** The role key, group key or user id, depending on `kind`. */
  target: string;
  reason: string;
}

export interface RuleForm {
  id: string;
  op: ThresholdOp;
  value: string;
  /** The stored value was a JSON number, so it goes back as one (a string would change the spec). */
  valueIsNumber: boolean;
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

const KINDS = ['role', 'group', 'user'] as const;

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
    valueIsNumber: false,
    step: { id: stepId, kind: 'role', target: 'management', reason: '' },
    afterStepId: '',
    reason: '',
  };
}

export function emptySpecForm(documentType = ''): SpecForm {
  return {
    documentType,
    distinctApprovers: true,
    remindAfterHours: '24',
    escalateAfterHours: '72',
    escalateRole: 'founder',
    steps: [emptyStep([])],
    rules: [],
  };
}

function stepToForm(step: StepSpec): StepForm | string {
  // A step that carries a field for another kind would lose it in the form.
  const stray = KINDS.filter((k) => k !== step.kind && step[k] !== undefined);
  if (stray.length > 0) return `step "${step.id}" also sets ${stray.join(', ')}`;
  return { id: step.id, kind: step.kind, target: step[step.kind] ?? '', reason: step.reason };
}

/** Null when `when` is not a single amountNpr comparison the form can show. */
function thresholdOf(
  when: Condition,
): { op: ThresholdOp; value: string; isNumber: boolean } | null {
  if (!('field' in when) || when.field !== THRESHOLD_FIELD) return null;
  if (when.op === 'in') return null;
  if (typeof when.value !== 'string' && typeof when.value !== 'number') return null;
  return { op: when.op, value: String(when.value), isNumber: typeof when.value === 'number' };
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
    const threshold = thresholdOf(r.when);
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
      valueIsNumber: threshold.isNumber,
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

const stepFromForm = (s: StepForm) => ({
  id: s.id.trim(),
  kind: s.kind,
  [s.kind]: s.target.trim(),
  reason: s.reason.trim(),
});

/** Builds the spec from the form and validates it; the issues are worded for the admin. */
export function formToSpec(form: SpecForm): SpecBuild {
  const draft = {
    documentType: form.documentType.trim(),
    steps: form.steps.map(stepFromForm),
    rules: form.rules.map((r) => {
      const trimmed = r.value.trim();
      const asNumber = Number(trimmed);
      return {
        id: r.id.trim(),
        when: {
          field: THRESHOLD_FIELD,
          op: r.op,
          value:
            r.valueIsNumber && trimmed !== '' && Number.isFinite(asNumber) ? asNumber : trimmed,
        },
        add: stepFromForm(r.step),
        position: r.afterStepId.trim() === '' ? 'end' : { after: r.afterStepId.trim() },
        reason: r.reason.trim(),
      };
    }),
    distinctApprovers: form.distinctApprovers,
    sla: {
      remindAfterHours: Number(form.remindAfterHours),
      escalateAfterHours: Number(form.escalateAfterHours),
      escalateTo: { role: form.escalateRole },
    },
  };
  const parsed = WorkflowSpecSchema.safeParse(draft);
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
  const parsed = WorkflowSpecSchema.safeParse(json);
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
  if (step.kind === 'user') return `Person: ${people[step.user ?? ''] ?? 'Name unavailable'}`;
  if (step.kind === 'group') return `Group: ${groups[step.group ?? ''] ?? 'Name unavailable'}`;
  return `Role: ${step.role ?? '(missing)'}`;
}
