'use client';

import { CURRENCIES, ROLE_KEYS, type SettingKey } from '@bos/contracts';
import { useActionState, useId, useState, type ReactNode } from 'react';

import { ResetToDefaultButton } from '@/components/settings/reset-to-default';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Panel } from '@/components/ui/panel';
import { toast } from '@/components/ui/toast';
import type { SettingsSectionId } from '@/lib/settings-nav';

import { IDLE, type ActionState } from '../action-state';
import { roleLabel } from '../users/role-checkboxes';
import { FormStatus } from '../ui';
import { saveCardAction } from './actions';
import type { FieldSpec } from './setting-fields';
import styles from './settings.module.css';

type Values = Record<string, string[]>;

const TRIGGER_LABEL: Record<string, string> = {
  advance: 'Advance',
  milestone: 'Milestone',
  uat: 'After acceptance',
  delivery: 'On delivery',
  date: 'On a date',
  manual: 'Manual',
};

interface ScheduleLine {
  label: string;
  percent: string;
  trigger: string;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * One card, one decision, one Save. Typed controls per setting; Save is enabled only while the card
 * differs from what is saved. Success is a toast (FormStatus); a refused field keeps its input and
 * shows its message at the field. The page remounts the card (new `key`) after a save, so the saved
 * values become the new baseline. A setting that differs from its default shows an undo icon beside
 * its label (D32); pressing it saves that one default immediately, apart from this card's Save, and
 * the remount drops any unsaved edits in the card's other fields.
 */
export function SettingCard({
  section,
  title,
  description,
  fields,
}: {
  section: SettingsSectionId;
  title: string;
  description?: string;
  fields: readonly FieldSpec[];
}) {
  const initial: Values = Object.fromEntries(
    fields.map((f) => [f.key, f.kind === 'currencies' ? f.current.split(/,\s*/) : [f.current]]),
  );
  const [values, setValues] = useState<Values>(initial);
  // A saved change gives the card new current values, so the page remounts it and drops the effect that would
  // announce the result: the success toast is raised here, from the action itself.
  const [state, formAction, pending] = useActionState(
    async (previous: ActionState, formData: FormData): Promise<ActionState> => {
      const result = await saveCardAction(previous, formData);
      if (result.status === 'ok') toast.success(result.message, { id: 'setting-card-saved' });
      return result;
    },
    IDLE,
  );
  const dirty = fields.some(
    (f) => (values[f.key] ?? []).join(',') !== (initial[f.key] ?? []).join(','),
  );
  const set = (key: SettingKey, next: string[]) => setValues((v) => ({ ...v, [key]: next }));

  return (
    <Panel title={title} description={description}>
      <form action={formAction} className={styles.form} noValidate>
        <input type="hidden" name="section" value={section} />
        <div className={styles.fields}>
          {fields.map((f) => (
            <div
              key={f.key}
              className={
                [
                  f.kind === 'currencies' || f.kind === 'schedule' || f.kind === 'sla'
                    ? styles.wide
                    : undefined,
                  // Makes room beside the label for the undo icon, only while there is one.
                  f.isDefault ? undefined : styles.resettable,
                ]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
            >
              <input type="hidden" name="key" value={f.key} />
              <input type="hidden" name={`i:${f.key}`} value={(initial[f.key] ?? []).join(',')} />
              <Control
                spec={f}
                value={values[f.key] ?? []}
                onChange={(next) => set(f.key, next)}
                error={state.status === 'error' ? state.fieldErrors?.[f.key] : undefined}
              />
              {/* A sibling of the control, never inside its label: the control keeps its own name.
                  A reset saves the default straight away, so the page remounts the card with it. */}
              <ResetToDefaultButton
                className={styles.resetSlot}
                section={section}
                settingKey={f.key}
                label={f.label}
                isDefault={f.isDefault}
                defaultText={f.defaultText}
                loadedVersion={f.version}
              />
            </div>
          ))}
        </div>
        <div className={styles.foot}>
          <div className={styles.status}>
            <FormStatus state={state} pending={pending} successToast={false} />
          </div>
          <Button type="submit" disabled={!dirty || pending}>
            Save
          </Button>
        </div>
      </form>
    </Panel>
  );
}

function Control({
  spec,
  value,
  onChange,
  error,
}: {
  spec: FieldSpec;
  value: string[];
  onChange: (next: string[]) => void;
  error: string | undefined;
}): ReactNode {
  const name = `v:${spec.key}`;
  const first = value[0] ?? '';
  switch (spec.kind) {
    case 'currencies':
      return <Currencies spec={spec} name={name} value={value} onChange={onChange} error={error} />;
    case 'sla':
      return (
        <Sla spec={spec} name={name} text={first} onChange={(t) => onChange([t])} error={error} />
      );
    case 'schedule':
      return (
        <Schedule
          spec={spec}
          name={name}
          text={first}
          onChange={(t) => onChange([t])}
          error={error}
        />
      );
    case 'select':
      return (
        <Field label={spec.label} hint={spec.help} error={error}>
          {(control) => (
            <Select
              name={name}
              value={first}
              onChange={(e) => onChange([e.currentTarget.value])}
              {...control}
            >
              {(spec.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      );
    default:
      return (
        <Field label={spec.label} hint={spec.help} error={error}>
          {(control) => (
            <Input
              name={name}
              value={first}
              onChange={(e) =>
                onChange([
                  spec.kind === 'prefix'
                    ? e.currentTarget.value.toUpperCase()
                    : e.currentTarget.value,
                ])
              }
              inputMode={
                spec.kind === 'integer' ? 'numeric' : spec.kind === 'prefix' ? 'text' : 'decimal'
              }
              autoComplete="off"
              spellCheck={false}
              {...control}
            />
          )}
        </Field>
      );
  }
}

function Currencies({
  spec,
  name,
  value,
  onChange,
  error,
}: {
  spec: FieldSpec;
  name: string;
  value: string[];
  onChange: (next: string[]) => void;
  error: string | undefined;
}) {
  const id = useId();
  return (
    <fieldset className={styles.fieldset} aria-invalid={error ? true : undefined}>
      <legend className={styles.legend}>{spec.label}</legend>
      {spec.help ? <p className={styles.help}>{spec.help}</p> : null}
      <div className={styles.checkGrid}>
        {CURRENCIES.map((currency) =>
          currency === 'NPR' ? (
            <label key={currency} className={styles.checkLabel} htmlFor={`${id}-NPR`}>
              {/* NPR is the books currency and cannot be switched off. A disabled box is not sent,
                  so the hidden field carries the value. */}
              <input
                id={`${id}-NPR`}
                className={styles.checkbox}
                type="checkbox"
                checked
                disabled
              />
              <input type="hidden" name={name} value="NPR" />
              NPR (always on)
            </label>
          ) : (
            <label key={currency} className={styles.checkLabel} htmlFor={`${id}-${currency}`}>
              <input
                id={`${id}-${currency}`}
                className={styles.checkbox}
                type="checkbox"
                name={name}
                value={currency}
                checked={value.includes(currency)}
                onChange={(e) =>
                  onChange(
                    e.currentTarget.checked
                      ? [...value, currency]
                      : value.filter((c) => c !== currency),
                  )
                }
              />
              {currency}
            </label>
          ),
        )}
      </div>
      {error ? <p className={styles.fieldError}>{error}</p> : null}
    </fieldset>
  );
}

/** Reminder and escalation times: three typed fields that serialise to the one JSON value. */
function Sla({
  spec,
  name,
  text,
  onChange,
  error,
}: {
  spec: FieldSpec;
  name: string;
  text: string;
  onChange: (text: string) => void;
  error: string | undefined;
}) {
  const sla = parseJson<{
    remindAfterHours?: number | string;
    escalateAfterHours?: number | string;
    escalateTo?: { role?: string };
  }>(text, {});
  const remind = String(sla.remindAfterHours ?? '');
  const escalate = String(sla.escalateAfterHours ?? '');
  const role = sla.escalateTo?.role ?? 'founder';
  // An unfinished number stays a string, so the Server Action's schema reports it at the field.
  const emit = (next: { remind?: string; escalate?: string; role?: string }) => {
    const num = (s: string) => (/^[0-9]+$/.test(s) ? Number(s) : s);
    onChange(
      JSON.stringify({
        remindAfterHours: num(next.remind ?? remind),
        escalateAfterHours: num(next.escalate ?? escalate),
        escalateTo: { role: next.role ?? role },
      }),
    );
  };
  return (
    <fieldset className={styles.fieldset} aria-invalid={error ? true : undefined}>
      <legend className={styles.legend}>{spec.label}</legend>
      {spec.help ? <p className={styles.help}>{spec.help}</p> : null}
      <input type="hidden" name={name} value={text} />
      <div className={styles.fields}>
        <Field label="Remind after (hours)">
          {(c) => (
            <Input
              value={remind}
              inputMode="numeric"
              autoComplete="off"
              onChange={(e) => emit({ remind: e.currentTarget.value })}
              {...c}
            />
          )}
        </Field>
        <Field label="Escalate after (hours)">
          {(c) => (
            <Input
              value={escalate}
              inputMode="numeric"
              autoComplete="off"
              onChange={(e) => emit({ escalate: e.currentTarget.value })}
              {...c}
            />
          )}
        </Field>
        <Field label="Escalate to">
          {(c) => (
            <Select value={role} onChange={(e) => emit({ role: e.currentTarget.value })} {...c}>
              {ROLE_KEYS.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      {error ? <p className={styles.fieldError}>{error}</p> : null}
    </fieldset>
  );
}

/** Billing slices as rows (label, percent, trigger) with a running total that must read 100%. */
function Schedule({
  spec,
  name,
  text,
  onChange,
  error,
}: {
  spec: FieldSpec;
  name: string;
  text: string;
  onChange: (text: string) => void;
  error: string | undefined;
}) {
  const lines = parseJson<ScheduleLine[]>(text, []);
  const write = (next: ScheduleLine[]) => onChange(JSON.stringify(next));
  const patch = (index: number, change: Partial<ScheduleLine>) =>
    write(lines.map((line, i) => (i === index ? { ...line, ...change } : line)));
  const total = lines.reduce((sum, l) => sum + (Number(l.percent) || 0), 0);
  const rounded = Math.round(total * 10000) / 10000;
  return (
    <fieldset className={styles.fieldset} aria-invalid={error ? true : undefined}>
      <legend className={styles.legend}>{spec.label}</legend>
      {spec.help ? <p className={styles.help}>{spec.help}</p> : null}
      <input type="hidden" name={name} value={text} />
      <ul className={styles.scheduleRows}>
        {lines.map((line, index) => (
          <li key={index} className={styles.scheduleRow}>
            <Field label="Label">
              {(c) => (
                <Input
                  value={line.label}
                  autoComplete="off"
                  maxLength={100}
                  onChange={(e) => patch(index, { label: e.currentTarget.value })}
                  {...c}
                />
              )}
            </Field>
            <Field label="Percent">
              {(c) => (
                <Input
                  value={line.percent}
                  inputMode="decimal"
                  autoComplete="off"
                  onChange={(e) => patch(index, { percent: e.currentTarget.value })}
                  {...c}
                />
              )}
            </Field>
            <Field label="Billed when">
              {(c) => (
                <Select
                  value={line.trigger}
                  onChange={(e) => patch(index, { trigger: e.currentTarget.value })}
                  {...c}
                >
                  {Object.entries(TRIGGER_LABEL).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button
              variant="ghost"
              size="small"
              disabled={lines.length <= 1}
              onClick={() => write(lines.filter((_, i) => i !== index))}
            >
              Remove<span className="sr-only"> row {index + 1}</span>
            </Button>
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <Button
          variant="secondary"
          size="small"
          disabled={lines.length >= 12}
          onClick={() => write([...lines, { label: '', percent: '', trigger: 'milestone' }])}
        >
          Add row
        </Button>
        <p className={styles.scheduleTotal} data-off={rounded !== 100} role="status">
          Total {rounded}% of 100%
        </p>
      </div>
      {error ? <p className={styles.fieldError}>{error}</p> : null}
    </fieldset>
  );
}
