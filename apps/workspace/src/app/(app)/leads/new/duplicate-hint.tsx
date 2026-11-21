'use client';
// The new-lead form's duplicate hint (F1-Q54 a). Wraps the form and listens to its company, person, email and phone
// inputs as they bubble up, so LeadForm itself is unchanged and is never remounted (typed values stay put). The hint
// only informs: it links the readable matches and never touches the form or its Save button.
import Link from 'next/link';
import { type FormEvent, type ReactNode, useState } from 'react';

import {
  type DuplicateFetcher,
  type DuplicateFields,
  fetchLeadDuplicates,
  useDuplicateHint,
} from '../_lib/use-duplicate-hint';
import styles from './duplicate-hint.module.css';

/** LeadForm's input names for the looked-up fields. */
const FIELD_OF_INPUT: Readonly<Record<string, keyof DuplicateFields>> = {
  companyName: 'company',
  contactName: 'name',
  email: 'email',
  phone: 'phone',
};

const EMPTY: DuplicateFields = { company: '', name: '', email: '', phone: '' };

export function LeadDuplicateHint({
  children,
  fetcher = fetchLeadDuplicates,
  delayMs,
}: {
  children: ReactNode;
  /** Tests pass a fake; the page uses the BFF route. */
  fetcher?: DuplicateFetcher;
  delayMs?: number;
}) {
  const [fields, setFields] = useState<DuplicateFields>(EMPTY);
  const matches = useDuplicateHint(fields, fetcher, delayMs);

  const onInput = (event: FormEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const field = FIELD_OF_INPUT[target.name];
    if (field === undefined) return;
    const value = target.value;
    setFields((current) => (current[field] === value ? current : { ...current, [field]: value }));
  };

  return (
    <div onInput={onInput}>
      {children}
      {/* Always mounted, so screen readers announce the hint when it fills in. */}
      <div className={styles.region} role="status" aria-live="polite" data-duplicate-hint="">
        {matches.length > 0 && (
          <div className={styles.hint}>
            <p className={styles.title}>A similar lead or customer exists</p>
            <ul className={styles.list}>
              {matches.map((m) => (
                <li key={`${m.kind}:${m.id}`}>
                  <Link
                    href={
                      m.kind === 'lead'
                        ? `/leads/${encodeURIComponent(m.id)}`
                        : `/customers/${encodeURIComponent(m.id)}`
                    }
                    target="_blank"
                    rel="noopener"
                  >
                    {m.label}
                  </Link>{' '}
                  <span className={styles.kind}>
                    ({m.kind}, matches {m.matchedOn.join(', ')})
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
