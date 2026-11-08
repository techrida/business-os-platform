'use client';

import { ROLE_KEYS, WorkflowSpecSchema, type RoleKey, type StepKind } from '@bos/contracts';
import { useActionState, useId, useState, type FormEvent } from 'react';

import styles from '../admin.module.css';
import { IDLE, type ActionState } from '../action-state';
import { FormStatus } from '../ui';
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
import type { UserOption } from './user-field';

type ServerAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;

interface Initial {
  mode: 'form' | 'json';
  form: SpecForm;
  json: string;
  notes: string[];
}

const pretty = (value: unknown): string => JSON.stringify(value, null, 2);

/** Opens in form mode when the spec fits the form without loss, otherwise in JSON mode with the reasons. */
function initialState(spec: unknown, documentType: string): Initial {
  if (spec === undefined) {
    return { mode: 'form', form: emptySpecForm(documentType), json: '', notes: [] };
  }
  const parsed = WorkflowSpecSchema.safeParse(spec);
  if (!parsed.success) {
    return {
      mode: 'json',
      form: emptySpecForm(documentType),
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
    form: emptySpecForm(parsed.data.documentType),
    json: pretty(parsed.data),
    notes: converted.reasons,
  };
}

/**
 * Edits a workflow spec as a form (steps with a role, group or user, plus amountNpr threshold rules)
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
}: {
  action: ServerAction;
  mode: 'create' | 'version';
  workflowKey?: string;
  documentType: string;
  initialSpec: unknown;
  submitLabel: string;
  groupKeys: readonly string[];
  users: readonly UserOption[] | null;
}) {
  const uid = useId();
  const [state, formAction, pending] = useActionState(action, IDLE);
  const [initial] = useState(() => initialState(initialSpec, documentType));
  const [view, setView] = useState<'form' | 'json'>(initial.mode);
  const [form, setForm] = useState<SpecForm>(initial.form);
  const [json, setJson] = useState(initial.json);
  const [notes, setNotes] = useState<string[]>(initial.notes);
  const [key, setKey] = useState('');
  const [name, setName] = useState('');
  const [issues, setIssues] = useState<string[]>([]);

  const built = view === 'form' ? formToSpec(form) : parseSpecJson(json);
  const lockedType = mode === 'version';

  const patch = (next: Partial<SpecForm>) => setForm((f) => ({ ...f, ...next }));
  const takenIds = [...form.steps.map((s) => s.id), ...form.rules.map((r) => r.step.id)];

  const updateStep = (i: number, next: Partial<StepForm>) =>
    patch({ steps: form.steps.map((s, n) => (n === i ? { ...s, ...next } : s)) });
  const moveStep = (i: number, by: -1 | 1) => {
    const steps = [...form.steps];
    const target = steps[i + by];
    const moving = steps[i];
    if (!target || !moving) return;
    steps[i + by] = moving;
    steps[i] = target;
    patch({ steps });
  };
  const updateRule = (i: number, next: Partial<RuleForm>) =>
    patch({ rules: form.rules.map((r, n) => (n === i ? { ...r, ...next } : r)) });
  const updateRuleStep = (i: number, next: Partial<StepForm>) =>
    patch({
      rules: form.rules.map((r, n) => (n === i ? { ...r, step: { ...r.step, ...next } } : r)),
    });

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

  const stepTarget = (id: string, step: StepForm, change: (n: Partial<StepForm>) => void) =>
    step.kind === 'role' ? (
      <select
        id={id}
        className={styles.select}
        value={step.target}
        onChange={(e) => change({ target: e.target.value })}
      >
        {ROLE_KEYS.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
    ) : (
      <>
        <input
          id={id}
          className={styles.input}
          value={step.target}
          list={`${id}-list`}
          autoComplete="off"
          placeholder={step.kind === 'group' ? 'Group key' : 'User id'}
          onChange={(e) => change({ target: e.target.value })}
        />
        <datalist id={`${id}-list`}>
          {step.kind === 'group'
            ? groupKeys.map((g) => <option key={g} value={g} />)
            : (users ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
        </datalist>
      </>
    );

  const changeKind = (current: StepForm, kind: StepKind): Partial<StepForm> => ({
    kind,
    target: kind === 'role' ? (current.kind === 'role' ? current.target : ROLE_KEYS[0]) : '',
  });

  const stepFields = (prefix: string, step: StepForm, change: (n: Partial<StepForm>) => void) => (
    <>
      <div className={styles.stepGrid}>
        <div className={styles.field}>
          <label htmlFor={`${prefix}-id`}>Step id</label>
          <input
            id={`${prefix}-id`}
            className={styles.input}
            value={step.id}
            autoComplete="off"
            onChange={(e) => change({ id: e.target.value })}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor={`${prefix}-kind`}>Approved by</label>
          <select
            id={`${prefix}-kind`}
            className={styles.select}
            value={step.kind}
            onChange={(e) => change(changeKind(step, e.target.value as StepKind))}
          >
            <option value="role">A role</option>
            <option value="group">A group</option>
            <option value="user">One person</option>
          </select>
        </div>
        <div className={styles.field}>
          <label htmlFor={`${prefix}-target`}>
            {step.kind === 'role' ? 'Role' : step.kind === 'group' ? 'Group' : 'Person'}
          </label>
          {stepTarget(`${prefix}-target`, step, change)}
        </div>
      </div>
      <div className={styles.field}>
        <label htmlFor={`${prefix}-reason`}>Reason shown to the approver</label>
        <input
          id={`${prefix}-reason`}
          className={styles.input}
          value={step.reason}
          maxLength={500}
          autoComplete="off"
          onChange={(e) => change({ reason: e.target.value })}
        />
      </div>
    </>
  );

  return (
    <form action={formAction} onSubmit={onSubmit} className={`${styles.form} ${styles.formWide}`}>
      {workflowKey ? <input type="hidden" name="key" value={workflowKey} /> : null}
      <input type="hidden" name="spec" value={built.ok ? JSON.stringify(built.spec) : ''} />

      {mode === 'create' ? (
        <div className={styles.formRow}>
          <div className={styles.field}>
            <label htmlFor={`${uid}-name`}>Workflow name</label>
            <input
              id={`${uid}-name`}
              className={styles.input}
              name="name"
              value={name}
              required
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className={styles.field}>
            <label htmlFor={`${uid}-key`}>Key</label>
            <input
              id={`${uid}-key`}
              className={styles.input}
              name="key"
              value={key}
              required
              autoComplete="off"
              pattern="[a-z][a-z0-9_.\-]{0,63}"
              aria-describedby={`${uid}-key-hint`}
              onChange={(e) => setKey(e.target.value)}
            />
            <span id={`${uid}-key-hint`} className={styles.hint}>
              Lowercase letters, digits, _ . - ; cannot be changed later.
            </span>
          </div>
        </div>
      ) : null}

      <div className={styles.actions}>
        <span className={styles.legend} id={`${uid}-view`}>
          Editing as
        </span>
        <span role="group" aria-labelledby={`${uid}-view`} className={styles.actions}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSmall} ${view === 'form' ? '' : styles.btnQuiet}`}
            aria-pressed={view === 'form'}
            onClick={() => (view === 'form' ? undefined : switchToForm())}
          >
            Form
          </button>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnSmall} ${view === 'json' ? '' : styles.btnQuiet}`}
            aria-pressed={view === 'json'}
            onClick={() => (view === 'json' ? undefined : switchToJson())}
          >
            JSON (advanced)
          </button>
        </span>
      </div>

      {notes.length > 0 ? (
        <div className={`${styles.notice} ${styles.noticeInfo}`}>
          <p>The form cannot show this spec without losing detail, so it stays in JSON:</p>
          <ul>
            {notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {view === 'json' ? (
        <div className={styles.field}>
          <label htmlFor={`${uid}-json`}>Workflow spec (JSON)</label>
          <textarea
            id={`${uid}-json`}
            className={styles.textarea}
            rows={16}
            spellCheck={false}
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
        </div>
      ) : (
        <>
          <div className={styles.formRow}>
            <div className={styles.field}>
              <label htmlFor={`${uid}-doctype`}>Document type</label>
              <input
                id={`${uid}-doctype`}
                className={styles.input}
                value={form.documentType}
                readOnly={lockedType}
                required
                autoComplete="off"
                aria-describedby={lockedType ? `${uid}-doctype-hint` : undefined}
                onChange={(e) => patch({ documentType: e.target.value })}
              />
              {lockedType ? (
                <span id={`${uid}-doctype-hint`} className={styles.hint}>
                  Fixed for this workflow.
                </span>
              ) : null}
            </div>
            <label className={styles.checkLabel} htmlFor={`${uid}-distinct`}>
              <input
                id={`${uid}-distinct`}
                className={styles.checkbox}
                type="checkbox"
                checked={form.distinctApprovers}
                onChange={(e) => patch({ distinctApprovers: e.target.checked })}
              />
              One person cannot approve two steps of the same request
            </label>
          </div>

          <div className={styles.stack}>
            <h4 className={styles.sub} style={{ margin: 0 }}>
              Steps, in order
            </h4>
            {form.steps.map((step, i) => (
              <fieldset key={i} className={`${styles.fieldset} ${styles.stepEditor}`}>
                <legend className={styles.legend}>Step {i + 1}</legend>
                {stepFields(`${uid}-s${i}`, step, (n) => updateStep(i, n))}
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnSmall} ${styles.btnQuiet}`}
                    disabled={i === 0}
                    onClick={() => moveStep(i, -1)}
                  >
                    Move up<span className={styles.srOnly}> step {i + 1}</span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnSmall} ${styles.btnQuiet}`}
                    disabled={i === form.steps.length - 1}
                    onClick={() => moveStep(i, 1)}
                  >
                    Move down<span className={styles.srOnly}> step {i + 1}</span>
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnSmall} ${styles.btnDanger}`}
                    onClick={() => patch({ steps: form.steps.filter((_, n) => n !== i) })}
                  >
                    Remove<span className={styles.srOnly}> step {i + 1}</span>
                  </button>
                </div>
              </fieldset>
            ))}
            <div>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSmall} ${styles.btnQuiet}`}
                onClick={() => patch({ steps: [...form.steps, emptyStep(takenIds)] })}
              >
                Add step
              </button>
            </div>
          </div>

          <div className={styles.stack}>
            <h4 className={styles.sub} style={{ margin: 0 }}>
              Threshold rules
            </h4>
            <p className={styles.hint}>
              A rule adds one more step when the amount in NPR meets a condition. More complex
              conditions (several fields, lists) can be written in the JSON editor.
            </p>
            {form.rules.length === 0 ? (
              <p className={styles.empty}>
                No threshold rules. Every request follows the steps above.
              </p>
            ) : null}
            {form.rules.map((rule, i) => {
              const prefix = `${uid}-r${i}`;
              return (
                <fieldset key={i} className={`${styles.fieldset} ${styles.stepEditor}`}>
                  <legend className={styles.legend}>Rule {i + 1}</legend>
                  <div className={styles.stepGrid}>
                    <div className={styles.field}>
                      <label htmlFor={`${prefix}-id`}>Rule id</label>
                      <input
                        id={`${prefix}-id`}
                        className={styles.input}
                        value={rule.id}
                        autoComplete="off"
                        onChange={(e) => updateRule(i, { id: e.target.value })}
                      />
                    </div>
                    <div className={styles.field}>
                      <label htmlFor={`${prefix}-op`}>When {THRESHOLD_FIELD}</label>
                      <select
                        id={`${prefix}-op`}
                        className={styles.select}
                        value={rule.op}
                        onChange={(e) => updateRule(i, { op: e.target.value as ThresholdOp })}
                      >
                        {THRESHOLD_OPS.map((op) => (
                          <option key={op} value={op}>
                            {OP_LABEL[op]}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className={styles.field}>
                      <label htmlFor={`${prefix}-value`}>Amount (NPR)</label>
                      <input
                        id={`${prefix}-value`}
                        className={styles.input}
                        value={rule.value}
                        inputMode="decimal"
                        autoComplete="off"
                        onChange={(e) => updateRule(i, { value: e.target.value })}
                      />
                    </div>
                  </div>
                  <p className={styles.legend} style={{ margin: '0.25rem 0 0' }}>
                    Then add this step
                  </p>
                  {stepFields(`${prefix}-step`, rule.step, (n) => updateRuleStep(i, n))}
                  <div className={styles.stepGrid}>
                    <div className={styles.field}>
                      <label htmlFor={`${prefix}-pos`}>Placed</label>
                      <select
                        id={`${prefix}-pos`}
                        className={styles.select}
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
                      </select>
                    </div>
                    <div className={styles.field} style={{ gridColumn: 'span 2' }}>
                      <label htmlFor={`${prefix}-reason`}>Why this rule exists</label>
                      <input
                        id={`${prefix}-reason`}
                        className={styles.input}
                        value={rule.reason}
                        maxLength={500}
                        autoComplete="off"
                        onChange={(e) => updateRule(i, { reason: e.target.value })}
                      />
                    </div>
                  </div>
                  <div className={styles.actions}>
                    <button
                      type="button"
                      className={`${styles.btn} ${styles.btnSmall} ${styles.btnDanger}`}
                      onClick={() => patch({ rules: form.rules.filter((_, n) => n !== i) })}
                    >
                      Remove<span className={styles.srOnly}> rule {i + 1}</span>
                    </button>
                  </div>
                </fieldset>
              );
            })}
            <div>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnSmall} ${styles.btnQuiet}`}
                onClick={() =>
                  patch({ rules: [...form.rules, emptyRule(takenIds, form.rules.length)] })
                }
              >
                Add threshold rule
              </button>
            </div>
          </div>

          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>Reminders and escalation</legend>
            <div className={styles.stepGrid} style={{ marginTop: '0.25rem' }}>
              <div className={styles.field}>
                <label htmlFor={`${uid}-remind`}>Remind after (hours)</label>
                <input
                  id={`${uid}-remind`}
                  className={styles.input}
                  inputMode="numeric"
                  value={form.remindAfterHours}
                  onChange={(e) => patch({ remindAfterHours: e.target.value })}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor={`${uid}-escalate`}>Escalate after (hours)</label>
                <input
                  id={`${uid}-escalate`}
                  className={styles.input}
                  inputMode="numeric"
                  value={form.escalateAfterHours}
                  onChange={(e) => patch({ escalateAfterHours: e.target.value })}
                />
              </div>
              <div className={styles.field}>
                <label htmlFor={`${uid}-escalate-to`}>Escalate to</label>
                <select
                  id={`${uid}-escalate-to`}
                  className={styles.select}
                  value={form.escalateRole}
                  onChange={(e) => patch({ escalateRole: e.target.value as RoleKey })}
                >
                  {ROLE_KEYS.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </fieldset>
        </>
      )}

      {issues.length > 0 ? (
        <div className={`${styles.notice} ${styles.noticeError}`} role="alert">
          <p>Fix these before saving:</p>
          <ul>
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className={styles.actions}>
        <button type="submit" className={styles.btn} disabled={pending}>
          {submitLabel}
        </button>
        <FormStatus state={state} pending={pending} />
      </div>
    </form>
  );
}
