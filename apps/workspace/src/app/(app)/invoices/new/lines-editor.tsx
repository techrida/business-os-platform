'use client';

import type { TaxCode } from '@bos/contracts';
import { useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';

import { MAX_LINES, newLine, type FieldErrors, type LineValues } from './lines';
import styles from './lines-editor.module.css';

/**
 * The lines of a manual invoice or a debit note, one small group per line: what, unit, quantity,
 * price and tax code. There is no per-line discount (the contract's line takes none), no amount
 * column and no total: the server prices the lines and the invoice page shows what it worked out.
 * Each line stacks its fields, so the editor fits the invoice page and a narrow dialog alike.
 */
export function useLines(initial: number = 1): {
  lines: LineValues[];
  setLine: (key: string, patch: Partial<LineValues>) => void;
  add: () => void;
  remove: (key: string) => void;
} {
  const counter = useRef(initial);
  const [lines, setLines] = useState<LineValues[]>(() =>
    Array.from({ length: initial }, (_, i) => newLine(`l${i + 1}`)),
  );
  return {
    lines,
    setLine: (key, patch) =>
      setLines((all) => all.map((l) => (l.key === key ? { ...l, ...patch } : l))),
    add: () => {
      counter.current += 1;
      const key = `l${counter.current}`;
      setLines((all) => (all.length >= MAX_LINES ? all : [...all, newLine(key)]));
    },
    remove: (key) => setLines((all) => (all.length > 1 ? all.filter((l) => l.key !== key) : all)),
  };
}

export function LinesEditor({
  lines,
  currency,
  taxCodes,
  errors,
  onChange,
  onAdd,
  onRemove,
}: {
  lines: readonly LineValues[];
  currency: string;
  /** null when the list failed to load. */
  taxCodes: readonly TaxCode[] | null;
  errors: Readonly<FieldErrors>;
  onChange: (key: string, patch: Partial<LineValues>) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
}) {
  const noTax = taxCodes === null || taxCodes.length === 0;
  return (
    <div className={styles.editor}>
      {taxCodes === null ? (
        <Alert tone="warning" role="status">
          The tax codes did not load, so a tax code cannot be chosen for a line. Reload the page to
          try again. What you typed is kept until you leave it.
        </Alert>
      ) : taxCodes.length === 0 ? (
        <Alert tone="warning" role="status">
          No tax codes are set up yet. Ask an administrator to add them, then reload.
        </Alert>
      ) : null}

      <ol className={styles.lines}>
        {lines.map((line, index) => {
          const no = index + 1;
          const e = (field: string) => errors[`lines.${index}.${field}`];
          const label = (text: string) => (
            <>
              {text}
              <span className="sr-only"> (line {no})</span>
            </>
          );
          return (
            <li key={line.key} className={styles.line}>
              <div className={styles.lineHead}>
                <span className={styles.lineNo}>Line {no}</span>
                {lines.length > 1 ? (
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={() => onRemove(line.key)}
                    aria-label={`Remove line ${no}`}
                  >
                    Remove
                  </Button>
                ) : null}
              </div>
              <div className={styles.fields}>
                <Field
                  label={label('Description')}
                  error={e('description')}
                  className={styles.wide ?? ''}
                >
                  {(control) => (
                    <Textarea
                      rows={2}
                      maxLength={500}
                      value={line.description}
                      onChange={(ev) => onChange(line.key, { description: ev.target.value })}
                      {...control}
                    />
                  )}
                </Field>
                <Field label={label('Unit')} error={e('uom')}>
                  {(control) => (
                    <Input
                      maxLength={20}
                      placeholder="pcs, hrs, lot"
                      value={line.uom}
                      onChange={(ev) => onChange(line.key, { uom: ev.target.value })}
                      {...control}
                    />
                  )}
                </Field>
                <Field label={label('Quantity')} error={e('quantity')}>
                  {(control) => (
                    <Input
                      inputMode="decimal"
                      autoComplete="off"
                      className={styles.numeric}
                      value={line.quantity}
                      onChange={(ev) => onChange(line.key, { quantity: ev.target.value })}
                      {...control}
                    />
                  )}
                </Field>
                <Field label={label(`Unit price (${currency})`)} error={e('unitPrice')}>
                  {(control) => (
                    <Input
                      inputMode="decimal"
                      autoComplete="off"
                      className={styles.numeric}
                      value={line.unitPrice}
                      onChange={(ev) => onChange(line.key, { unitPrice: ev.target.value })}
                      {...control}
                    />
                  )}
                </Field>
                <Field label={label('Tax code')} error={e('taxCodeId')}>
                  {(control) => (
                    <Select
                      disabled={noTax}
                      value={line.taxCodeId}
                      onChange={(ev) => onChange(line.key, { taxCodeId: ev.target.value })}
                      {...control}
                    >
                      <option value="">Choose</option>
                      {(taxCodes ?? []).map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
            </li>
          );
        })}
      </ol>

      {errors['lines'] ? (
        <p role="alert" className={styles.error}>
          {errors['lines']}
        </p>
      ) : null}

      <div className={styles.add}>
        <Button variant="secondary" onClick={onAdd} disabled={lines.length >= MAX_LINES}>
          Add line
        </Button>
        {lines.length >= MAX_LINES ? (
          <span className={styles.hint}>An invoice holds up to {MAX_LINES} lines.</span>
        ) : null}
      </div>
    </div>
  );
}
