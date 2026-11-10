'use client';
import type { MemoDirectory } from '@bos/contracts';
import { useId, useRef, useState } from 'react';
import { Input } from '@/components/ui/field';
import styles from './memo-template.module.css';
export const STAFF_GROUPING_THRESHOLD = 20;
type Person = MemoDirectory['people'][number];
export function StaffPicker({
  label,
  people,
  value,
  onChange,
  open,
  onOpen,
}: {
  label: string;
  people: Person[];
  value: string;
  onChange: (id: string) => void;
  open: boolean;
  onOpen: (open: boolean) => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const duplicateName = (person: Person) => people.filter((p) => p.name === person.name).length > 1;
  const selected = people.find((p) => p.userId === value);
  const filtered = people
    .filter((p) =>
      query
        .toLowerCase()
        .split(/\s+/)
        .every((q) =>
          `${p.name} ${p.jobTitle ?? ''} ${p.department ?? ''}`.toLowerCase().includes(q),
        ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  const groups =
    people.length > STAFF_GROUPING_THRESHOLD
      ? [...new Set(filtered.map((p) => p.department ?? 'Unassigned'))].sort()
      : [''];
  const close = () => {
    onOpen(false);
    trigger.current?.focus();
  };
  return (
    <div
      className={styles.picker}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onOpen(false);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          close();
        }
      }}
    >
      <button
        className={styles.trigger}
        ref={trigger}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-haspopup="dialog"
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            onOpen(true);
            setQuery('');
          }
        }}
        onClick={() => {
          onOpen(!open);
          setQuery('');
        }}
      >
        {label}:{' '}
        {selected ? (
          <>
            {selected.name} {selected.jobTitle ? <span>({selected.jobTitle})</span> : null}
          </>
        ) : (
          'Choose staff member'
        )}
      </button>
      {open ? (
        <div className={styles.popup} id={id} role="dialog" aria-label={`Choose ${label}`}>
          <Input
            ref={search}
            autoFocus
            aria-label={`Search ${label}`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                e.currentTarget.parentElement?.querySelector<HTMLButtonElement>('button')?.focus();
              }
            }}
          />
          <div className={styles.results}>
            {groups.map((group) => (
              <section key={group} aria-label={group || 'Staff'}>
                {group ? <h3 className={styles.group}>{group}</h3> : null}
                {filtered
                  .filter((p) => !group || (p.department ?? 'Unassigned') === group)
                  .map((p) => (
                    <button
                      key={p.userId}
                      className={styles.option}
                      type="button"
                      aria-pressed={p.userId === value}
                      onClick={() => {
                        onChange(p.userId);
                        close();
                      }}
                      onKeyDown={(e) => {
                        const buttons = Array.from(
                          e.currentTarget.closest(`.${styles.results}`)!.querySelectorAll('button'),
                        );
                        const index = buttons.indexOf(e.currentTarget);
                        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                          e.preventDefault();
                          buttons[
                            (index + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) %
                              buttons.length
                          ]?.focus();
                        }
                      }}
                    >
                      <strong>{p.name}</strong> {p.jobTitle ? <span>({p.jobTitle})</span> : null} ·{' '}
                      {p.department ?? 'Unassigned'}{' '}
                      {duplicateName(p) ? `· Staff reference ${p.userId.slice(-8)}` : ''}{' '}
                      {p.userId === value ? '✓' : ''}
                    </button>
                  ))}
              </section>
            ))}
          </div>
          <div role="status">{filtered.length === 0 ? 'No matching staff members.' : ''}</div>
        </div>
      ) : null}
    </div>
  );
}
