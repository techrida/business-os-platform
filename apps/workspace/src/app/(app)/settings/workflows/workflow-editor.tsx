'use client';

import {
  DEFAULT_DEPARTMENT_HEAD_FALLBACK_ROLE,
  ROLE_KEYS,
  WorkflowSpecSchema,
  workflowAmountIssue,
  type RoleKey,
  type StepKind,
} from '@bos/contracts';
import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { MemberPicker } from '@/components/ui/member-picker';
import { DecimalInput, MoneyInput } from '@/components/ui/number-input';
import { SuggestInput } from '@/components/ui/suggest-input';

import { IDLE, type ActionState } from '../action-state';
import adminStyles from '../admin.module.css';
import { FormStatus } from '../ui';
import styles from './editor.module.css';
import {
  OP_LABEL,
  THRESHOLD_FIELD,
  THRESHOLD_OPS,
  emptyRule,
  emptySpecForm,
  emptyStep,
  formToSpec,
  parseSpecJson,
  specToForm,
  type RuleForm,
  type SpecForm,
  type StepForm,
  type ThresholdOp,
} from './spec-form';
import { memberOptions, type UserOption } from './user-field';

type SlaDefaults = Parameters<typeof emptySpecForm>[1];

type ServerAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;

interface Initial {
  mode: 'form' | 'json';
  form: SpecForm;
  json: string;
  notes: string[];
}

// CSS-module lookups are `string | undefined` under noUncheckedIndexedAccess; Field wants a string.
const SPAN = styles.span ?? '';

/**
 * Reminder and escalation hours are whole numbers. The SLA schema sets no maximum; 9 digits matches
 * the default-times card, so a saved default always fits this box.
 */
const HOURS_DIGITS = 9;

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

/** Opens in form mode when the spec fits the form without loss, otherwise in JSON mode with the reasons. */
function initialState(spec: unknown, documentType: string, sla: SlaDefaults | undefined): Initial {
  if (spec === undefined) {
    return { mode: 'form', form: emptySpecForm(documentType, sla), json: '', notes: [] };
  }
  const parsed = WorkflowSpecSchema.safeParse(spec);
  if (!parsed.success) {
    return {
      mode: 'json',
      form: emptySpecForm(documentType, sla),
      json: pretty(spec),
      notes: [
        'The saved spec does not match the current format, so it can only be edited as JSON.',
      ],
    };
  }
  const converted = specToForm(parsed.data);
  if (converted.ok) {
    return { mode: 'form', form: converted.form, json: pretty(parsed.data), notes: [] };
  }
  return {
    mode: 'json',
    form: emptySpecForm(parsed.data.documentType, sla),
    json: pretty(parsed.data),
    notes: converted.reasons,
  };
}

/**
 * One numbered block of the form (Figma Add forms: "01 · The basics" over the section title). The
 * number is decoration, hidden from assistive technology; the heading names the section.
 */
function Section({
  number,
  label,
  title,
  hint,
  children,
}: {
  number: number;
  label: string;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={styles.section}>
      <div>
        <span aria-hidden="true" className={styles.sectionNumber}>
          {String(number).padStart(2, '0')} · {label}
        </span>
        <h4 id={headingId} className={styles.sectionTitle}>
          {title}
        </h4>
      </div>
      {hint ? <p className={styles.sectionHint}>{hint}</p> : null}
      {children}
    </section>
  );
}

/**
 * Edits a workflow spec as a form (steps with a role, group, user or department head, plus amountNpr threshold rules
 * and the saved fact rules FactCondition describes)
 * or as raw JSON for anything the form cannot show. A spec the form cannot represent opens in JSON
 * mode, so nothing is dropped silently. The page decides what saving means: creating a workflow, or
 * adding the next draft version.
 */
export function WorkflowEditor({
  action,
  mode,
  workflowKey,
  documentType,
  initialSpec,
  submitLabel,
  groupKeys,
  users,
  slaDefaults,
}: {
  action: ServerAction;
  mode: 'create' | 'version';
  workflowKey?: string;
  documentType: string;
  initialSpec: unknown;
  submitLabel: string;
  groupKeys: readonly string[];
  users: readonly UserOption[] | null;
  /** The saved default reminder and escalation times a new form starts from; the built-in default when omitted. */
  slaDefaults?: SlaDefaults;
}) {
  const viewLabelId = useId();
  const [state, formAction, pending] = useActionState(action, IDLE);
  const [initial] = useState(() => initialState(initialSpec, documentType, slaDefaults));
  const [view, setView] = useState<'form' | 'json'>(initial.mode);
  const [form, setForm] = useState<SpecForm>(initial.form);
  const [json, setJson] = useState(initial.json);
  const [notes, setNotes] = useState<string[]>(initial.notes);
  // Until a rule builder exists, raw JSON is offered only for a saved spec the form cannot show (Kuu, U23-Q4).
  const jsonAvailable = initial.mode === 'json';
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [issues, setIssues] = useState<string[]>([]);

  const formRef = useRef<HTMLFormElement>(null);
  const issuesRef = useRef<HTMLDivElement>(null);
  // Rows are keyed by position, so after a move or a remove the focused button is a different row's
  // (or gone). The handler names the data-focus targets to try, in order, once the new rows render.
  const pendingFocus = useRef<string[] | null>(null);

  const built = view === 'form' ? formToSpec(form) : parseSpecJson(json);
  const lockedType = mode === 'version';

  const patch = (next: Partial<SpecForm>) => setForm((f) => ({ ...f, ...next }));
  const takenIds = [...form.steps.map((s) => s.id), ...form.rules.map((r) => r.step.id)];

  useEffect(() => {
    const targets = pendingFocus.current;
    if (!targets) return;
    pendingFocus.current = null;
    for (const target of targets) {
      const el = formRef.current?.querySelector<HTMLElement>(`[data-focus="${target}"]`);
      if (el && !(el as HTMLButtonElement).disabled) {
        el.focus();
        return;
      }
    }
  });

  // A failed submit or toggle moves focus to the summary, so the problems are read out even when the
  // same ones come back and the summary sits far from the button that was pressed.
  useEffect(() => {
    if (issues.length > 0) issuesRef.current?.focus();
  }, [issues]);

  const updateStep = (i: number, next: Partial<StepForm>) =>
    patch({ steps: form.steps.map((s, n) => (n === i ? { ...s, ...next } : s)) });
  const moveStep = (i: number, by: -1 | 1) => {
    const steps = [...form.steps];
    const target = steps[i + by];
    const moving = steps[i];
    if (!target || !moving) return;
    steps[i + by] = moving;
    steps[i] = target;
    pendingFocus.current =
      by < 0
        ? [`step-${i + by}-up`, `step-${i + by}-down`]
        : [`step-${i + by}-down`, `step-${i + by}-up`];
    patch({ steps });
  };
  const removeStep = (i: number) => {
    pendingFocus.current = [`step-${i}-remove`, `step-${i - 1}-remove`, 'add-step'];
    patch({ steps: form.steps.filter((_, n) => n !== i) });
  };
  const addStep = () => {
    pendingFocus.current = [`step-${form.steps.length}-id`];
    patch({ steps: [...form.steps, emptyStep(takenIds)] });
  };
  const updateRule = (i: number, next: Partial<RuleForm>) =>
    patch({ rules: form.rules.map((r, n) => (n === i ? { ...r, ...next } : r)) });
  const updateRuleStep = (i: number, next: Partial<StepForm>) =>
    patch({
      rules: form.rules.map((r, n) => (n === i ? { ...r, step: { ...r.step, ...next } } : r)),
    });
  const removeRule = (i: number) => {
    pendingFocus.current = [`rule-${i}-remove`, `rule-${i - 1}-remove`, 'add-rule'];
    patch({ rules: form.rules.filter((_, n) => n !== i) });
  };
  const addRule = () => {
    pendingFocus.current = [`rule-${form.rules.length}-id`];
    patch({ rules: [...form.rules, emptyRule(takenIds, form.rules.length)] });
  };

  function switchToJson() {
    const out = formToSpec(form);
    if (!out.ok) {
      setIssues(out.issues);
      return;
    }
    setIssues([]);
    setJson(pretty(out.spec));
    setView('json');
  }

  function switchToForm() {
    const out = parseSpecJson(json);
    if (!out.ok) {
      setIssues(out.issues);
      return;
    }
    const converted = specToForm(out.spec);
    if (!converted.ok) {
      setIssues([]);
      setNotes(converted.reasons);
      return;
    }
    setIssues([]);
    setNotes([]);
    setForm(converted.form);
    setView('form');
  }

  // Catch mistakes here so the admin sees them next to the form; the Server Action checks again.
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    if (!built.ok) {
      event.preventDefault();
      setIssues(built.issues);
    } else {
      setIssues([]);
    }
  }

  const changeKind = (current: StepForm, kind: StepKind): Partial<StepForm> => ({
    kind,
    target:
      kind === 'department_head'
        ? DEFAULT_DEPARTMENT_HEAD_FALLBACK_ROLE
        : kind === 'role'
          ? current.kind === 'role'
            ? current.target
            : ROLE_KEYS[0]
          : '',
  });

  /** The control for a step's role, group or person, depending on its kind. */
  const stepTarget = (step: StepForm, change: (n: Partial<StepForm>) => void) => {
    const label =
      step.kind === 'role'
        ? 'Role'
        : step.kind === 'department_head'
          ? 'If there is no head, use role'
          : step.kind === 'group'
            ? 'Group'
            : 'Person';
    return (
      <Field label={label}>
        {(control) =>
          step.kind === 'role' || step.kind === 'department_head' ? (
            <Select
              {...control}
              value={step.target}
              onChange={(e) => change({ target: e.target.value })}
            >
              {ROLE_KEYS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          ) : step.kind === 'user' ? (
            <MemberPicker
              labelledBy={control['aria-labelledby']}
              describedBy={control['aria-describedby']}
              people={memberOptions(users ?? [])}
              value={step.target}
              onChange={(target) => change({ target })}
              current={
                step.target !== '' && !(users ?? []).some((u) => u.id === step.target)
                  ? { id: step.target, name: 'Current person (name unavailable)' }
                  : undefined
              }
              placeholder="Choose a person"
              disabled={users === null && step.target === ''}
            />
          ) : (
            <SuggestInput
              {...control}
              value={step.target}
              suggestions={groupKeys}
              autoComplete="off"
              placeholder="Group key"
              onChange={(target) => change({ target })}
            />
          )
        }
      </Field>
    );
  };

  /** Id, kind, target and reason of one approval step; shared by the steps and by a rule's added step. */
  const stepFields = (
    step: StepForm,
    change: (n: Partial<StepForm>) => void,
    focusKey?: string,
  ) => (
    <div className={styles.grid}>
      <Field label="Step id">
        {(control) => (
          <Input
            {...control}
            value={step.id}
            autoComplete="off"
            data-focus={focusKey}
            onChange={(e) => change({ id: e.target.value })}
          />
        )}
      </Field>
      <Field label="Approved by">
        {(control) => (
          <Select
            {...control}
            value={step.kind}
            onChange={(e) => change(changeKind(step, e.target.value as StepKind))}
          >
            <option value="role">A role</option>
            <option value="group">A group</option>
            <option value="user">One person</option>
            <option value="department_head">Department head</option>
          </Select>
        )}
      </Field>
      {stepTarget(step, change)}
      <Field label="Reason shown to the approver" className={SPAN}>
        {(control) => (
          <Input
            {...control}
            value={step.reason}
            maxLength={500}
            autoComplete="off"
            onChange={(e) => change({ reason: e.target.value })}
          />
        )}
      </Field>
    </div>
  );

  const hasBasics = mode === 'create' || view === 'form';
  const basicsCount = hasBasics ? 1 : 0;

  return (
    <form ref={formRef} action={formAction} onSubmit={onSubmit} className={styles.editor}>
      {workflowKey ? <input type="hidden" name="key" value={workflowKey} /> : null}
      <input type="hidden" name="spec" value={built.ok ? JSON.stringify(built.spec) : ''} />

      {jsonAvailable ? (
        <div className={styles.toolbar}>
          <span className={styles.toolbarLabel} id={viewLabelId}>
            Editing as
          </span>
          <span role="group" aria-labelledby={viewLabelId} className={styles.toggle}>
            <Button
              size="small"
              variant={view === 'form' ? 'secondary' : 'ghost'}
              aria-pressed={view === 'form'}
              onClick={() => (view === 'form' ? undefined : switchToForm())}
            >
              Form
            </Button>
            <Button
              size="small"
              variant={view === 'json' ? 'secondary' : 'ghost'}
              aria-pressed={view === 'json'}
              onClick={() => (view === 'json' ? undefined : switchToJson())}
            >
              JSON (advanced)
            </Button>
          </span>
        </div>
      ) : null}

      {notes.length > 0 ? (
        <Alert
          tone="info"
          title="The form cannot show this spec without losing detail, so it stays in JSON:"
        >
          <ul className={styles.messageList}>
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {hasBasics ? (
        <Section number={1} label="The basics" title="Workflow">
          <div className={styles.grid}>
            {mode === 'create' ? (
              <>
                <Field label="Workflow name">
                  {(control) => (
                    <Input
                      {...control}
                      name="name"
                      value={name}
                      required
                      autoComplete="off"
                      onChange={(e) => setName(e.target.value)}
                    />
                  )}
                </Field>
                <Field
                  label="Key"
                  hint="Lowercase letters, digits, _ . - ; cannot be changed later."
                >
                  {(control) => (
                    <Input
                      {...control}
                      name="key"
                      value={key}
                      required
                      autoComplete="off"
                      pattern="[a-z][a-z0-9_.\-]{0,63}"
                      onChange={(e) => setKey(e.target.value)}
                    />
                  )}
                </Field>
              </>
            ) : null}
            {view === 'form' ? (
              <>
                <Field
                  label="Document type"
                  hint={lockedType ? 'Fixed for this workflow.' : undefined}
                >
                  {(control) => (
                    <Input
                      {...control}
                      value={form.documentType}
                      readOnly={lockedType}
                      required
                      autoComplete="off"
                      onChange={(e) => patch({ documentType: e.target.value })}
                    />
                  )}
                </Field>
                <label className={`${styles.check} ${SPAN}`}>
                  <input
                    type="checkbox"
                    checked={form.distinctApprovers}
                    onChange={(e) => patch({ distinctApprovers: e.target.checked })}
                  />
                  One person cannot approve two steps of the same request
                </label>
              </>
            ) : null}
          </div>
        </Section>
      ) : null}

      {view === 'json' ? (
        <Section number={basicsCount + 1} label="The spec" title="Workflow spec">
          <Field label="Workflow spec (JSON)">
            {(control) => (
              <Textarea
                {...control}
                className={styles.json}
                rows={16}
                spellCheck={false}
                value={json}
                onChange={(e) => setJson(e.target.value)}
              />
            )}
          </Field>
        </Section>
      ) : (
        <>
          <Section number={2} label="The approvals" title="Steps, in order">
            <div className={styles.rows}>
              {form.steps.map((step, i) => (
                <fieldset key={i} className={styles.row}>
                  <legend className={styles.rowLegend}>Step {i + 1}</legend>
                  <div className={styles.rowBody}>
                    {stepFields(step, (n) => updateStep(i, n), `step-${i}-id`)}
                    <div className={styles.rowActions}>
                      <Button
                        size="small"
                        variant="ghost"
                        data-focus={`step-${i}-up`}
                        disabled={i === 0}
                        onClick={() => moveStep(i, -1)}
                      >
                        Move up<span className="sr-only"> step {i + 1}</span>
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        data-focus={`step-${i}-down`}
                        disabled={i === form.steps.length - 1}
                        onClick={() => moveStep(i, 1)}
                      >
                        Move down<span className="sr-only"> step {i + 1}</span>
                      </Button>
                      <Button
                        size="small"
                        variant="secondary"
                        data-focus={`step-${i}-remove`}
                        className={`${adminStyles.danger} ${adminStyles.dangerOutline} ${styles.remove}`}
                        onClick={() => removeStep(i)}
                      >
                        Remove<span className="sr-only"> step {i + 1}</span>
                      </Button>
                    </div>
                  </div>
                </fieldset>
              ))}
              {form.steps.length === 0 ? (
                <p className={styles.empty}>
                  {form.rules.length > 0
                    ? 'No fixed steps. Every step comes from the rules below.'
                    : 'No steps yet. Add the first approval step.'}
                </p>
              ) : null}
            </div>
            <div className={styles.addRow}>
              <Button size="small" variant="secondary" data-focus="add-step" onClick={addStep}>
                Add step
              </Button>
            </div>
          </Section>

          <Section
            number={3}
            label="The conditions"
            title="Rules"
            hint={
              jsonAvailable
                ? 'A rule adds one more step when its condition is met. A new rule tests the amount in NPR. More complex conditions (several fields, lists) can be written in the JSON editor.'
                : 'A rule adds one more step when its condition is met. A new rule tests the amount in NPR.'
            }
          >
            <div className={styles.rows}>
              {form.rules.length === 0 ? (
                <p className={styles.empty}>No rules. Every request follows the steps above.</p>
              ) : null}
              {form.rules.map((rule, i) => (
                <fieldset key={i} className={styles.row}>
                  <legend className={styles.rowLegend}>Rule {i + 1}</legend>
                  <div className={styles.rowBody}>
                    <div className={styles.grid}>
                      <Field label="Rule id">
                        {(control) => (
                          <Input
                            {...control}
                            value={rule.id}
                            autoComplete="off"
                            data-focus={`rule-${i}-id`}
                            onChange={(e) => updateRule(i, { id: e.target.value })}
                          />
                        )}
                      </Field>
                      {rule.fact?.field === 'fromSchedule' ? (
                        <Field label="When the invoice">
                          {(control) => (
                            <Select
                              {...control}
                              value={String(rule.fact?.value === true)}
                              onChange={(e) =>
                                updateRule(i, {
                                  fact: { field: 'fromSchedule', value: e.target.value === 'true' },
                                })
                              }
                            >
                              <option value="false">
                                is not from an approved billing schedule
                              </option>
                              <option value="true">is from an approved billing schedule</option>
                            </Select>
                          )}
                        </Field>
                      ) : rule.fact?.field === 'kind' ? (
                        <Field
                          label="When the document type is"
                          hint="Matches every request of this type."
                        >
                          {(control) => (
                            <Input {...control} value={String(rule.fact?.value ?? '')} readOnly />
                          )}
                        </Field>
                      ) : (
                        <>
                          <Field label={`When ${THRESHOLD_FIELD}`}>
                            {(control) => (
                              <Select
                                {...control}
                                value={rule.op}
                                onChange={(e) =>
                                  updateRule(i, { op: e.target.value as ThresholdOp })
                                }
                              >
                                {THRESHOLD_OPS.map((op) => (
                                  <option key={op} value={op}>
                                    {OP_LABEL[op]}
                                  </option>
                                ))}
                              </Select>
                            )}
                          </Field>
                          <Field
                            label="Amount"
                            error={
                              issues.length > 0
                                ? (workflowAmountIssue(rule.value.trim()) ?? undefined)
                                : undefined
                            }
                          >
                            {(control) => (
                              <MoneyInput
                                {...control}
                                currency="NPR"
                                value={rule.value}
                                onValueChange={(value) => updateRule(i, { value })}
                              />
                            )}
                          </Field>
                        </>
                      )}
                    </div>
                    <RuleStepGroup title="Then add this step">
                      {stepFields(rule.step, (n) => updateRuleStep(i, n))}
                    </RuleStepGroup>
                    <div className={styles.grid}>
                      <Field label="Placement">
                        {(control) => (
                          <Select
                            {...control}
                            value={rule.afterStepId}
                            onChange={(e) => updateRule(i, { afterStepId: e.target.value })}
                          >
                            <option value="">At the end</option>
                            {takenIds
                              .filter((id) => id !== rule.step.id && id !== '')
                              .map((id) => (
                                <option key={id} value={id}>
                                  After {id}
                                </option>
                              ))}
                          </Select>
                        )}
                      </Field>
                      <Field label="Why this rule exists" className={SPAN}>
                        {(control) => (
                          <Input
                            {...control}
                            value={rule.reason}
                            maxLength={500}
                            autoComplete="off"
                            onChange={(e) => updateRule(i, { reason: e.target.value })}
                          />
                        )}
                      </Field>
                    </div>
                    <div className={styles.rowActions}>
                      <Button
                        size="small"
                        variant="secondary"
                        data-focus={`rule-${i}-remove`}
                        className={`${adminStyles.danger} ${adminStyles.dangerOutline} ${styles.remove}`}
                        onClick={() => removeRule(i)}
                      >
                        Remove<span className="sr-only"> rule {i + 1}</span>
                      </Button>
                    </div>
                  </div>
                </fieldset>
              ))}
            </div>
            <div className={styles.addRow}>
              <Button size="small" variant="secondary" data-focus="add-rule" onClick={addRule}>
                Add rule
              </Button>
            </div>
          </Section>

          <Section number={4} label="The timing" title="Reminders and escalation">
            <div className={styles.grid}>
              <Field label="Remind after (hours)">
                {(control) => (
                  <DecimalInput
                    {...control}
                    intDigits={HOURS_DIGITS}
                    scale={0}
                    value={form.remindAfterHours}
                    onValueChange={(remindAfterHours) => patch({ remindAfterHours })}
                  />
                )}
              </Field>
              <Field label="Escalate after (hours)">
                {(control) => (
                  <DecimalInput
                    {...control}
                    intDigits={HOURS_DIGITS}
                    scale={0}
                    value={form.escalateAfterHours}
                    onValueChange={(escalateAfterHours) => patch({ escalateAfterHours })}
                  />
                )}
              </Field>
              <Field label="Escalate to">
                {(control) => (
                  <Select
                    {...control}
                    value={form.escalateRole}
                    onChange={(e) => patch({ escalateRole: e.target.value as RoleKey })}
                  >
                    {ROLE_KEYS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          </Section>
        </>
      )}

      {issues.length > 0 ? (
        <Alert
          ref={issuesRef}
          tabIndex={-1}
          role="alert"
          tone="error"
          title="Fix these before saving:"
        >
          <ul className={styles.messageList}>
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className={styles.submit}>
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
        <div>
          <FormStatus state={state} pending={pending} />
        </div>
      </div>
    </form>
  );
}

/** "Then add this step" inside a rule: a named group so its controls are announced together. */
function RuleStepGroup({ title, children }: { title: string; children: ReactNode }) {
  const titleId = useId();
  return (
    <div role="group" aria-labelledby={titleId} className={styles.subgroup}>
      <p id={titleId} className={styles.subgroupTitle}>
        {title}
      </p>
      {children}
    </div>
  );
}
