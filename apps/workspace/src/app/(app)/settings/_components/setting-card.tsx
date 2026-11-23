'use client';

import {
  CURRENCIES,
  MONEY_LIMITS,
  ROLE_KEYS,
  type Currency,
  type RoleKey,
  type ScheduleTrigger,
} from '@bos/contracts';
import { useId, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input, Select, type FieldControlProps } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { DecimalInput, PercentInput } from '@/components/ui/number-input';
import { Panel } from '@/components/ui/panel';
import type { SettingsSectionId } from '@/lib/settings-nav';

import { roleLabel } from '../users/role-checkboxes';
import {
  PERSON_DEFAULT_OPTION,
  TRIGGER_OPTIONS,
  scheduleSummary,
  type FieldSpec,
  type ScheduleRowValue,
  type SettingFieldValue,
  type SlaFieldValue,
} from './setting-fields';
import { SettingsForm, useSettingsFormContext, type SaveSettingsPageAction } from './settings-form';
import styles from './settings.module.css';
import { Tooltip } from '@/components/ui/tooltip';

/**
 * Whole digits for a whole-number setting the contracts give no upper bound (`z.number().int()`,
 * the reminder hours): 9 digits stays exact in a JavaScript number and in a 32-bit integer.
 */
const WHOLE_NUMBER_DIGITS = 9;

/** Decimals a step allows: `'0.01'` is 2, `'1'` is 0. */
function stepScale(step: string): number {
  return step.split('.')[1]?.length ?? 0;
}

/** The percent input's scale for a step, never fewer decimals than the step needs. */
function percentScale(step: string): 0 | 2 | 4 {
  const scale = stepScale(step);
  return scale === 0 ? 0 : scale <= 2 ? 2 : 4;
}

/** A number bound as the plain decimal string the number inputs compare exactly. */
const bound = (value: number | undefined) => (value === undefined ? undefined : String(value));

export interface SettingCardProps {
  /** Required only when rendered standalone outside `<SettingsForm>`. */
  section?: SettingsSectionId;
  title: string;
  description?: string;
  fields: readonly FieldSpec[];
  /** Optional save action override when rendered standalone in tests. */
  saveAction?: SaveSettingsPageAction;
}

/**
 * Distinct counter-clockwise circle arrow icon for Reset to default, so it is visually separate
 * from Undo change (`undo-2`). Decorative: the enclosing button carries the accessible label.
 */
function ResetDefaultIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
    </svg>
  );
}

/**
 * Moves focus to the first control of the setting `button` belongs to. Undo and Reset remove their own
 * button once the value is back, so without this focus would fall to the page body (U23-Q5). The
 * control stays mounted, so it is focused before React re-renders.
 */
function focusSettingControl(button: HTMLElement): void {
  const item = button.closest('[data-setting]');
  if (item === null) return;
  const control = Array.from(
    item.querySelectorAll<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled])',
    ),
  ).find((element) => element.closest('[data-field-actions]') === null);
  control?.focus();
}

/**
 * Per-setting Undo (restores saved value, shown only when dirty) and Reset to default (stages the
 * built-in default in the form, shown only when current value differs from default).
 * Always rendered as siblings of `<label>`, never inside it, so inputs keep their exact name.
 */
function FieldActions({
  spec,
  dirty,
  atDefault,
  onUndo,
  onResetToDefault,
  className,
}: {
  spec: FieldSpec;
  dirty: boolean;
  atDefault: boolean;
  onUndo: () => void;
  onResetToDefault: () => void;
  className?: string | undefined;
}) {
  if (!dirty && atDefault) return null;
  return (
    <span className={[styles.fieldActions, className].filter(Boolean).join(' ')} data-field-actions>
      {dirty ? (
        <Tooltip content="Undo change">
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`Undo change to ${spec.label}`}
            onClick={(event) => {
              focusSettingControl(event.currentTarget);
              onUndo();
            }}
          >
            <Icon name="undo-2" size={16} />
          </button>
        </Tooltip>
      ) : null}
      {!atDefault ? (
        <Tooltip content={`Back to default (${spec.defaultText})`}>
          <button
            type="button"
            className={styles.iconButton}
            aria-label={`Reset ${spec.label} to default`}
            onClick={(event) => {
              focusSettingControl(event.currentTarget);
              onResetToDefault();
            }}
          >
            <ResetDefaultIcon />
          </button>
        </Tooltip>
      ) : null}
    </span>
  );
}

/**
 * Renders one settings panel with always-editable typed controls.
 * Inside `<SettingsForm>`, participates in the single page-level Save/Discard bar.
 * When rendered standalone with a `section`, wraps itself in a `<SettingsForm>`.
 */
export function SettingCard({ section, title, description, fields, saveAction }: SettingCardProps) {
  const form = useSettingsFormContext();
  if (form === null) {
    if (!section) {
      throw new Error('SettingCard must be rendered inside SettingsForm or be given a section.');
    }
    return (
      <SettingsForm section={section} fields={fields} {...(saveAction ? { saveAction } : {})}>
        <SettingCardPanel title={title} description={description} fields={fields} />
      </SettingsForm>
    );
  }
  return <SettingCardPanel title={title} description={description} fields={fields} />;
}

function SettingCardPanel({
  title,
  description,
  fields,
}: {
  title: string;
  description?: string | undefined;
  fields: readonly FieldSpec[];
}) {
  const form = useSettingsFormContext();
  if (form === null) return null;

  return (
    <Panel title={title} description={description}>
      <div className={styles.fields}>
        {fields.map((spec) => {
          const state = form.getFieldState(spec);
          const isGroup =
            spec.kind === 'currencies' || spec.kind === 'schedule' || spec.kind === 'sla';
          const actionCount = (state.dirty ? 1 : 0) + (state.atDefault ? 0 : 1);
          const actions = (
            <FieldActions
              spec={spec}
              dirty={state.dirty}
              atDefault={state.atDefault}
              onUndo={() => form.undoField(spec.key)}
              onResetToDefault={() => form.resetFieldToDefault(spec)}
              className={isGroup ? undefined : styles.fieldActionsOverlay}
            />
          );

          return (
            <div
              key={spec.key}
              data-setting={spec.key}
              className={[
                isGroup ? styles.wide : styles.fieldItem,
                !isGroup && actionCount > 0 ? styles.hasActions : undefined,
              ]
                .filter(Boolean)
                .join(' ')}
              data-actions={!isGroup && actionCount > 0 ? String(actionCount) : undefined}
            >
              <Control
                spec={spec}
                value={state.value}
                onChange={(next) => form.setFieldValue(spec.key, next)}
                error={state.error}
                groupActions={isGroup ? actions : undefined}
              />
              {!isGroup ? actions : null}
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

function Control({
  spec,
  value,
  onChange,
  error,
  groupActions,
}: {
  spec: FieldSpec;
  value: SettingFieldValue;
  onChange: (next: SettingFieldValue) => void;
  error: string | undefined;
  groupActions?: ReactNode;
}): ReactNode {
  switch (spec.kind) {
    case 'currencies':
      return (
        <CurrenciesControl
          spec={spec}
          values={value.kind === 'currencies' ? value.values : ['NPR']}
          onChange={(values) => onChange({ kind: 'currencies', values })}
          error={error}
          actions={groupActions}
        />
      );
    case 'sla':
      return (
        <SlaControl
          spec={spec}
          value={
            value.kind === 'sla'
              ? value.value
              : { remindAfterHours: '24', escalateAfterHours: '72', escalateToRole: 'founder' }
          }
          onChange={(next) => onChange({ kind: 'sla', value: next })}
          error={error}
          actions={groupActions}
        />
      );
    case 'schedule':
      return (
        <ScheduleControl
          spec={spec}
          rows={value.kind === 'schedule' ? value.rows : []}
          onChange={(rows) => onChange({ kind: 'schedule', rows })}
          error={error}
          actions={groupActions}
        />
      );
    case 'select': {
      const textValue = value.kind === 'text' ? value.value : '';
      return (
        <Field label={spec.label} hint={spec.help} error={error}>
          {(control) => (
            <Select
              name={`v:${spec.key}`}
              value={textValue}
              onChange={(e) => onChange({ kind: 'text', value: e.currentTarget.value })}
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
    }
    case 'person': {
      const textValue = value.kind === 'text' ? value.value : '';
      return (
        <Field label={spec.label} hint={spec.help} error={error}>
          {(control) => (
            <Select
              name={`v:${spec.key}`}
              value={textValue}
              onChange={(e) => onChange({ kind: 'text', value: e.currentTarget.value })}
              {...control}
            >
              <option value="">{PERSON_DEFAULT_OPTION}</option>
              {(spec.options ?? []).map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      );
    }
    case 'prefix': {
      const textValue = value.kind === 'text' ? value.value : '';
      return (
        <Field label={spec.label} hint={spec.help} error={error}>
          {(control) => (
            <Input
              name={`v:${spec.key}`}
              type="text"
              maxLength={10}
              value={textValue}
              onChange={(e) =>
                onChange({ kind: 'text', value: e.currentTarget.value.toUpperCase() })
              }
              autoComplete="off"
              spellCheck={false}
              {...control}
            />
          )}
        </Field>
      );
    }
    case 'integer':
    case 'percent':
    case 'money': {
      const textValue = value.kind === 'text' ? value.value : '';
      const bounds = spec.numberBounds;
      const step = bounds?.step ?? (spec.kind === 'integer' ? '1' : '0.01');
      const shared = {
        name: `v:${spec.key}`,
        min: bound(bounds?.min),
        max: bound(bounds?.max),
        value: textValue,
        onValueChange: (next: string) => onChange({ kind: 'text', value: next }),
      };
      return (
        <Field label={spec.label} hint={spec.help} error={error}>
          {(control) =>
            spec.kind === 'percent' ? (
              <PercentInput {...control} {...shared} scale={percentScale(step)} />
            ) : spec.kind === 'money' ? (
              <DecimalInput
                {...control}
                {...shared}
                intDigits={MONEY_LIMITS.intDigits}
                scale={Math.min(stepScale(step), MONEY_LIMITS.scale)}
              />
            ) : (
              <DecimalInput
                {...control}
                {...shared}
                intDigits={
                  bounds?.max === undefined ? WHOLE_NUMBER_DIGITS : String(bounds.max).length
                }
                scale={0}
              />
            )
          }
        </Field>
      );
    }
    default: {
      const _exhaustive: never = spec.kind;
      return _exhaustive;
    }
  }
}

/**
 * A group's error line. Always mounted, empty until there is an error, so screen readers are already
 * watching the live region when the message arrives (a region inserted together with its text is
 * often not announced). Empty, it takes no space (`.fieldError:empty`).
 */
function GroupError({ id, error }: { id: string; error: string | undefined }) {
  return (
    <p id={id} className={styles.fieldError} role="alert">
      {error ?? ''}
    </p>
  );
}

/** The group's own ids for `aria-describedby`: its help line, and its error while there is one. */
function groupDescribedBy(helpId: string | undefined, errorId: string, error: string | undefined) {
  return [helpId, error ? errorId : undefined].filter(Boolean).join(' ') || undefined;
}

/** A control inside a group: invalid with the group, and described by the group's error line too. */
function inGroup(
  control: FieldControlProps,
  errorId: string,
  error: string | undefined,
): FieldControlProps {
  if (!error) return control;
  return {
    ...control,
    'aria-invalid': true,
    'aria-describedby': [control['aria-describedby'], errorId].filter(Boolean).join(' '),
  };
}

function CurrenciesControl({
  spec,
  values,
  onChange,
  error,
  actions,
}: {
  spec: FieldSpec;
  values: readonly Currency[];
  onChange: (next: readonly Currency[]) => void;
  error: string | undefined;
  actions?: ReactNode;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;

  const toggle = (currency: Currency, checked: boolean) => {
    const picked = new Set<Currency>(values);
    picked.add('NPR');
    if (checked) picked.add(currency);
    else if (currency !== 'NPR') picked.delete(currency);
    onChange(CURRENCIES.filter((c) => picked.has(c)));
  };

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={groupDescribedBy(spec.help ? helpId : undefined, errorId, error)}
      className={styles.group}
      data-invalid={error ? 'true' : undefined}
    >
      <div className={styles.groupHeader}>
        <p id={labelId} className={styles.groupLabel}>
          {spec.label}
        </p>
        {actions}
      </div>
      {spec.help ? (
        <p id={helpId} className={styles.help}>
          {spec.help}
        </p>
      ) : null}
      <div className={styles.checkGrid}>
        {CURRENCIES.map((currency) =>
          currency === 'NPR' ? (
            <label key={currency} className={styles.checkLabel} htmlFor={`${id}-NPR`}>
              <input
                id={`${id}-NPR`}
                className={styles.checkbox}
                type="checkbox"
                value="NPR"
                checked
                disabled
              />
              NPR (always on)
            </label>
          ) : (
            <label key={currency} className={styles.checkLabel} htmlFor={`${id}-${currency}`}>
              <input
                id={`${id}-${currency}`}
                className={styles.checkbox}
                type="checkbox"
                value={currency}
                checked={values.includes(currency)}
                onChange={(e) => toggle(currency, e.currentTarget.checked)}
              />
              {currency}
            </label>
          ),
        )}
      </div>
      <GroupError id={errorId} error={error} />
    </div>
  );
}

/** Reminder and escalation defaults: three flat typed controls with no JSON state. */
function SlaControl({
  spec,
  value,
  onChange,
  error,
  actions,
}: {
  spec: FieldSpec;
  value: SlaFieldValue;
  onChange: (next: SlaFieldValue) => void;
  error: string | undefined;
  actions?: ReactNode;
}) {
  const labelId = useId();
  const helpId = `${labelId}-help`;
  const errorId = `${labelId}-error`;
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={groupDescribedBy(spec.help ? helpId : undefined, errorId, error)}
      className={styles.group}
      data-invalid={error ? 'true' : undefined}
    >
      <div className={styles.groupHeader}>
        <p id={labelId} className={styles.groupLabel}>
          {spec.label}
        </p>
        {actions}
      </div>
      {spec.help ? (
        <p id={helpId} className={styles.help}>
          {spec.help}
        </p>
      ) : null}
      <div className={styles.fields}>
        <Field label="Remind after (hours)">
          {(c) => (
            <DecimalInput
              {...inGroup(c, errorId, error)}
              intDigits={WHOLE_NUMBER_DIGITS}
              scale={0}
              min="1"
              value={value.remindAfterHours}
              onValueChange={(next) => onChange({ ...value, remindAfterHours: next })}
            />
          )}
        </Field>
        <Field label="Escalate after (hours)">
          {(c) => (
            <DecimalInput
              {...inGroup(c, errorId, error)}
              intDigits={WHOLE_NUMBER_DIGITS}
              scale={0}
              min="1"
              value={value.escalateAfterHours}
              onValueChange={(next) => onChange({ ...value, escalateAfterHours: next })}
            />
          )}
        </Field>
        <Field label="Escalate to">
          {(c) => (
            <Select
              name={`v:${spec.key}:role`}
              value={value.escalateToRole}
              onChange={(e) =>
                onChange({ ...value, escalateToRole: e.currentTarget.value as RoleKey })
              }
              {...inGroup(c, errorId, error)}
            >
              {ROLE_KEYS.map((r) => (
                <option key={r} value={r}>
                  {roleLabel(r)}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <GroupError id={errorId} error={error} />
    </div>
  );
}

/** Billing schedule rows (label, percent 0–100, trigger from contract enum) with exact running total. */
function ScheduleControl({
  spec,
  rows,
  onChange,
  error,
  actions,
}: {
  spec: FieldSpec;
  rows: readonly ScheduleRowValue[];
  onChange: (next: readonly ScheduleRowValue[]) => void;
  error: string | undefined;
  actions?: ReactNode;
}) {
  const labelId = useId();
  const helpId = `${labelId}-help`;
  const errorId = `${labelId}-error`;
  const nextRowIdRef = useRef(rows.length);
  const [rowKeys, setRowKeys] = useState<string[]>(() => rows.map((_, i) => `row-${i}`));

  const patch = (index: number, change: Partial<ScheduleRowValue>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...change } : row)));
  };

  const addRow = () => {
    if (rows.length >= 12) return;
    nextRowIdRef.current += 1;
    const nextId = `row-${nextRowIdRef.current}`;
    setRowKeys((prev) => [...prev.slice(0, rows.length), nextId]);
    onChange([...rows, { label: '', percent: '', trigger: 'milestone' }]);
  };

  const removeRow = (index: number) => {
    if (rows.length <= 1) return;
    // Undo, reset and discard replace the rows without telling this list, so rebuild the keys first.
    setRowKeys((prev) =>
      rows
        .map((_, i) => prev[i] ?? `row-pad-${(nextRowIdRef.current += 1)}`)
        .filter((_, i) => i !== index),
    );
    onChange(rows.filter((_, i) => i !== index));
  };

  const summary = scheduleSummary(rows);
  const isOff = summary.status !== 'ok';

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={groupDescribedBy(spec.help ? helpId : undefined, errorId, error)}
      className={styles.group}
      data-invalid={error ? 'true' : undefined}
    >
      <div className={styles.groupHeader}>
        <p id={labelId} className={styles.groupLabel}>
          {spec.label}
        </p>
        {actions}
      </div>
      {spec.help ? (
        <p id={helpId} className={styles.help}>
          {spec.help}
        </p>
      ) : null}
      <ul className={styles.scheduleRows}>
        {rows.map((row, index) => (
          <li key={rowKeys[index] ?? `row-idx-${index}`} className={styles.scheduleRow}>
            <Field label="Label">
              {(c) => (
                <Input
                  type="text"
                  value={row.label}
                  autoComplete="off"
                  maxLength={100}
                  onChange={(e) => patch(index, { label: e.currentTarget.value })}
                  {...inGroup(c, errorId, error)}
                />
              )}
            </Field>
            <Field label="Percent">
              {(c) => (
                <PercentInput
                  {...inGroup(c, errorId, error)}
                  scale={4}
                  min="0"
                  max="100"
                  value={row.percent}
                  onValueChange={(next) => patch(index, { percent: next })}
                />
              )}
            </Field>
            <Field label="Billed when">
              {(c) => (
                <Select
                  name={`v:${spec.key}:trigger:${index}`}
                  value={row.trigger}
                  onChange={(e) =>
                    patch(index, { trigger: e.currentTarget.value as ScheduleTrigger })
                  }
                  {...inGroup(c, errorId, error)}
                >
                  {TRIGGER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Button
              variant="ghost"
              size="small"
              disabled={rows.length <= 1}
              onClick={() => removeRow(index)}
            >
              Remove<span className="sr-only"> row {index + 1}</span>
            </Button>
          </li>
        ))}
      </ul>
      <div className={styles.actions}>
        <Button variant="secondary" size="small" disabled={rows.length >= 12} onClick={addRow}>
          Add row
        </Button>
        <p className={styles.scheduleTotal} data-off={isOff} role="status">
          Total {summary.totalText}% of 100%
          {summary.status === 'short' || summary.status === 'over'
            ? ` — ${summary.actionText}`
            : summary.status === 'invalid'
              ? ' — Enter 0 to 100 for each row'
              : ''}
        </p>
      </div>
      <GroupError id={errorId} error={error} />
    </div>
  );
}
