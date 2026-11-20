'use client';

import {
  CURRENCIES,
  ROLE_KEYS,
  type Currency,
  type RoleKey,
  type ScheduleTrigger,
} from '@bos/contracts';
import { useId, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { Panel } from '@/components/ui/panel';
import type { SettingsSectionId } from '@/lib/settings-nav';

import { roleLabel } from '../users/role-checkboxes';
import {
  TRIGGER_OPTIONS,
  scheduleSummary,
  type FieldSpec,
  type ScheduleRowValue,
  type SettingFieldValue,
  type SlaFieldValue,
} from './setting-fields';
import { SettingsForm, useSettingsFormContext, type SaveSettingsPageAction } from './settings-form';
import styles from './settings.module.css';

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
    <span className={[styles.fieldActions, className].filter(Boolean).join(' ')}>
      {dirty ? (
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`Undo change to ${spec.label}`}
          title="Undo change"
          onClick={onUndo}
        >
          <Icon name="undo-2" size={16} />
        </button>
      ) : null}
      {!atDefault ? (
        <button
          type="button"
          className={styles.iconButton}
          aria-label={`Reset ${spec.label} to default`}
          title={`Back to default (${spec.defaultText})`}
          onClick={onResetToDefault}
        >
          <ResetDefaultIcon />
        </button>
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
      return (
        <Field label={spec.label} hint={spec.help} error={error}>
          {(control) => (
            <Input
              name={`v:${spec.key}`}
              type="number"
              min={bounds?.min}
              max={bounds?.max}
              step={bounds?.step ?? (spec.kind === 'integer' ? '1' : '0.01')}
              inputMode={spec.kind === 'integer' ? 'numeric' : 'decimal'}
              value={textValue}
              onChange={(e) => onChange({ kind: 'text', value: e.currentTarget.value })}
              autoComplete="off"
              spellCheck={false}
              {...control}
            />
          )}
        </Field>
      );
    }
    default: {
      const _exhaustive: never = spec.kind;
      return _exhaustive;
    }
  }
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
      className={styles.group}
      data-invalid={error ? 'true' : undefined}
    >
      <div className={styles.groupHeader}>
        <p id={labelId} className={styles.groupLabel}>
          {spec.label}
        </p>
        {actions}
      </div>
      {spec.help ? <p className={styles.help}>{spec.help}</p> : null}
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
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
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
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={styles.group}
      data-invalid={error ? 'true' : undefined}
    >
      <div className={styles.groupHeader}>
        <p id={labelId} className={styles.groupLabel}>
          {spec.label}
        </p>
        {actions}
      </div>
      {spec.help ? <p className={styles.help}>{spec.help}</p> : null}
      <div className={styles.fields}>
        <Field label="Remind after (hours)">
          {(c) => (
            <Input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={value.remindAfterHours}
              autoComplete="off"
              onChange={(e) => onChange({ ...value, remindAfterHours: e.currentTarget.value })}
              {...c}
            />
          )}
        </Field>
        <Field label="Escalate after (hours)">
          {(c) => (
            <Input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              value={value.escalateAfterHours}
              autoComplete="off"
              onChange={(e) => onChange({ ...value, escalateAfterHours: e.currentTarget.value })}
              {...c}
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
              {...c}
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
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
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
    setRowKeys((prev) => prev.filter((_, i) => i !== index));
    onChange(rows.filter((_, i) => i !== index));
  };

  const summary = scheduleSummary(rows);
  const isOff = summary.status !== 'ok';

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={styles.group}
      data-invalid={error ? 'true' : undefined}
    >
      <div className={styles.groupHeader}>
        <p id={labelId} className={styles.groupLabel}>
          {spec.label}
        </p>
        {actions}
      </div>
      {spec.help ? <p className={styles.help}>{spec.help}</p> : null}
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
                  {...c}
                />
              )}
            </Field>
            <Field label="Percent">
              {(c) => (
                <Input
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  inputMode="decimal"
                  value={row.percent}
                  autoComplete="off"
                  onChange={(e) => patch(index, { percent: e.currentTarget.value })}
                  {...c}
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
                  {...c}
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
      {error ? (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
