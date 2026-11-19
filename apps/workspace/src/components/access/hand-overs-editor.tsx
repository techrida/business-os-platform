'use client';

import type { AssignmentHandOver, AssignmentHandOverInput } from '@bos/contracts';
import { useId, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Select } from '@/components/ui/select';

import styles from './area-cards.module.css';

export interface DepartmentOption {
  id: string;
  name: string;
}

/**
 * "Can hand over to another department" (spec 6.3): a list of From → To pairs, a remove icon per
 * pair and "Add hand-over" with two department pickers. A pair naming a retired department is
 * struck through and can only be removed. Staged like every other control of the card.
 */
export function HandOversEditor({
  value,
  known,
  departments,
  disabled,
  onChange,
  undo,
}: {
  value: readonly AssignmentHandOverInput[];
  /** The saved and default pairs, which carry department names and retired flags. */
  known: readonly AssignmentHandOver[];
  /** Active departments, or null when they could not load. */
  departments: readonly DepartmentOption[] | null;
  disabled: boolean;
  onChange: (next: AssignmentHandOverInput[]) => void;
  undo?: ReactNode;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const legendId = useId();
  const fromId = useId();
  const toId = useId();

  const active = new Set(departments?.map((d) => d.id) ?? []);
  const nameOf = (id: string): string =>
    departments?.find((d) => d.id === id)?.name ??
    known.find((p) => p.fromDepartmentId === id)?.fromDepartmentName ??
    known.find((p) => p.toDepartmentId === id)?.toDepartmentName ??
    'Unknown department';
  const retired = (id: string): boolean => {
    if (departments) return !active.has(id);
    return known.some(
      (p) =>
        (p.fromDepartmentId === id && p.fromRetired === true) ||
        (p.toDepartmentId === id && p.toRetired === true),
    );
  };
  const exists = value.some((p) => p.fromDepartmentId === from && p.toDepartmentId === to);
  const canAdd = from !== '' && to !== '' && from !== to && !exists;
  const options = [
    { value: '', label: 'Choose a department' },
    ...(departments ?? []).map((d) => ({ value: d.id, label: d.name })),
  ];

  function add() {
    if (!canAdd) return;
    onChange([...value, { fromDepartmentId: from, toDepartmentId: to }]);
    setFrom('');
    setTo('');
  }

  return (
    <fieldset className={styles.handOvers} aria-labelledby={legendId}>
      <div className={styles.lineHead}>
        <span id={legendId} className={styles.lineLabel}>
          Can hand over to another department
        </span>
        {undo}
      </div>
      {value.length === 0 ? (
        <p className={styles.hint}>No hand-overs. People assign only within their department.</p>
      ) : (
        <ul className={styles.pairs}>
          {value.map((pair) => {
            const fromName = nameOf(pair.fromDepartmentId);
            const toName = nameOf(pair.toDepartmentId);
            const gone = retired(pair.fromDepartmentId) || retired(pair.toDepartmentId);
            return (
              <li key={`${pair.fromDepartmentId}>${pair.toDepartmentId}`} className={styles.pair}>
                <span className={gone ? styles.retired : undefined}>
                  {fromName} <span aria-hidden="true">→</span>
                  <span className="sr-only"> to </span> {toName}
                </span>
                {gone ? <span className="sr-only"> (a retired department)</span> : null}
                {disabled ? null : (
                  <button
                    type="button"
                    className={styles.iconButton}
                    aria-label={`Remove hand-over ${fromName} to ${toName}`}
                    onClick={() =>
                      onChange(
                        value.filter(
                          (p) =>
                            p.fromDepartmentId !== pair.fromDepartmentId ||
                            p.toDepartmentId !== pair.toDepartmentId,
                        ),
                      )
                    }
                  >
                    <Icon name="x" size={16} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {disabled ? null : departments === null ? (
        <p className={styles.hint}>
          Departments could not load, so a hand-over cannot be added now.
        </p>
      ) : (
        <div className={styles.addPair}>
          <div className={styles.pairField}>
            <label htmlFor={fromId} className={styles.smallLabel}>
              From
            </label>
            <Select
              id={fromId}
              options={options}
              value={from}
              onChange={(event) => setFrom(event.target.value)}
            />
          </div>
          <div className={styles.pairField}>
            <label htmlFor={toId} className={styles.smallLabel}>
              To
            </label>
            <Select
              id={toId}
              options={options}
              value={to}
              onChange={(event) => setTo(event.target.value)}
            />
          </div>
          <Button variant="secondary" disabled={!canAdd} onClick={add}>
            Add hand-over
          </Button>
        </div>
      )}
      <p className={styles.hint}>
        The receiver must be at or below the sender&apos;s level. The reverse direction needs its
        own hand-over.
      </p>
    </fieldset>
  );
}
