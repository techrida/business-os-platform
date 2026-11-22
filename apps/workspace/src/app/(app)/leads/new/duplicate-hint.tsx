'use client';
// The new-lead form's duplicate hint (F1-Q54 a). Wraps the form and listens to its company, person and email inputs as
// they bubble up, so LeadForm is never remounted (typed values stay put). The phone comes as a prop instead: the
// lead's primary number in E.164, which the phone list reports through LeadForm's `onPrimaryPhoneChange` (see
// new-lead-form.tsx). The hint only informs: it links the readable matches and never touches the form or its Save.
import Link from 'next/link';
import { type FormEvent, type ReactNode, useState } from 'react';

import {
  type DuplicateFetcher,
  type DuplicateFields,
  fetchLeadDuplicates,
  useDuplicateHint,
} from '../_lib/use-duplicate-hint';
import styles from './duplicate-hint.module.css';

type TypedFields = Omit<DuplicateFields, 'phone'>;

/** LeadForm's input names for the looked-up typed fields. */
const FIELD_OF_INPUT: Readonly<Record<string, keyof TypedFields>> = {
  companyName: 'company',
  contactName: 'name',
  email: 'email',
};

const EMPTY: TypedFields = { company: '', name: '', email: '' };

export function LeadDuplicateHint({
  children,
  phone = null,
  fetcher = fetchLeadDuplicates,
  delayMs,
}: {
  children: ReactNode;
  /** The lead's primary number as E.164, or null while none is complete and valid. */
  phone?: string | null | undefined;
  /** Tests pass a fake; the page uses the BFF route. */
  fetcher?: DuplicateFetcher | undefined;
  delayMs?: number | undefined;
}) {
  const [typed, setTyped] = useState<TypedFields>(EMPTY);
  const matches = useDuplicateHint({ ...typed, phone }, fetcher, delayMs);

  const onInput = (event: FormEvent<HTMLDivElement>) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    const field = FIELD_OF_INPUT[target.name];
    if (field === undefined) return;
    const value = target.value;
    setTyped((current) => (current[field] === value ? current : { ...current, [field]: value }));
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
