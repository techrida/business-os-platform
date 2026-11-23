'use client';
import { MEMO_MAX_RECOMMENDERS, type MemoApproverRule, type MemoDirectory } from '@bos/contracts';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { useExclusiveOpen } from '@/components/ui/combobox';

import { approverHint, ruleApproverChoices } from './approver-rule';
import { PlusIcon, TrashIcon } from './memo-icons';
import {
  addRecommender,
  canAddRecommender,
  focusAfterRemoval,
  removeRecommender,
  setRecommender,
  type RecommenderRows,
} from './signer-rows';
import styles from './memo-template.module.css';
import { approverChoices, StaffPicker } from './staff-picker';
import { Tooltip } from '@/components/ui/tooltip';

type Person = MemoDirectory['people'][number];

/** Said when nobody in the company holds approval rights, so there is no one to name. */
const NO_APPROVERS =
  'No staff member has approval rights yet. Ask an administrator to give someone an approver role.';

/** One signer block: the same small label above the same picker layout for Prepared, Recommended and Approved. */
function SignerGroup({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const labelId = useId();
  const hintId = useId();
  return (
    <div
      role="group"
      aria-labelledby={labelId}
      aria-describedby={hint ? hintId : undefined}
      className={styles.signerGroup}
    >
      <span id={labelId} className={styles.signerLabel}>
        {label}
      </span>
      {hint ? (
        <span id={hintId} className={styles.signerHint}>
          {hint}
        </span>
      ) : null}
      {children}
    </div>
  );
}

/**
 * Prepared by, Recommended by and Approved by. Prepared is the signed-in author and can only be searched or chosen
 * as that person (the server refuses anyone else). Recommended starts with two blank rows; a blank row is simply
 * unused. Each recommender row reads "1. Enter Name" with a red delete button; at most 20 rows. Only one list is
 * open at a time. Approved by lists only who the Memo approver rule allows (F1-Q9) and says why under the label.
 */
export function SignerSection({
  people,
  currentUserId,
  recommenders,
  onRecommenders,
  approvedBy,
  onApprovedBy,
  approverRule,
}: {
  people: readonly Person[];
  currentUserId: string;
  recommenders: RecommenderRows;
  onRecommenders: (rows: RecommenderRows) => void;
  approvedBy: string;
  onApprovedBy: (userId: string) => void;
  /** Who may approve this memo; absent from an API that predates it. */
  approverRule?: MemoApproverRule | undefined;
}) {
  const exclusive = useExclusiveOpen();
  const preparer = useMemo(
    () => people.filter((p) => p.userId === currentUserId),
    [people, currentUserId],
  );
  // Everyone already placed somewhere else is shown but cannot be picked again (the API rejects duplicates).
  const taken = useMemo(
    () => new Set([currentUserId, approvedBy, ...recommenders].filter((id) => id !== '')),
    [currentUserId, approvedBy, recommenders],
  );
  const noApprovers = !people.some((p) => p.canApprove);
  const without = (own: string): ReadonlySet<string> => {
    const next = new Set(taken);
    if (own !== '') next.delete(own);
    return next;
  };

  const inputs = useRef<Array<HTMLInputElement | null>>([]);
  const addButton = useRef<HTMLButtonElement>(null);
  // Where focus goes once React has rendered the changed rows; a ref, because it needs no re-render of its own.
  const pendingFocus = useRef<number | 'add' | null>(null);
  const [status, setStatus] = useState('');
  useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    pendingFocus.current = null;
    if (target === 'add') addButton.current?.focus();
    else inputs.current[target]?.focus();
  }, [recommenders]);

  return (
    <div className={styles.signerSection}>
      <SignerGroup label="Prepared by">
        <div className={styles.signerRow}>
          <StaffPicker
            label="Prepared by"
            people={preparer}
            value={currentUserId}
            // Clearing the text only empties the box for a moment: the author stays the signed-in person.
            onChange={() => undefined}
            open={exclusive.isOpen('prepared')}
            onOpenChange={(open) => exclusive.setOpen('prepared', open)}
          />
        </div>
      </SignerGroup>

      <SignerGroup
        label="Recommended by"
        hint={
          noApprovers
            ? NO_APPROVERS
            : 'Optional. Only people who can decide approvals are listed. Choose them in approval-route order; empty rows are ignored.'
        }
      >
        {recommenders.map((id, i) => (
          // Rows are positional (a blank row has no identity), so the index is the key.
          <div className={styles.signerRow} key={i}>
            <span className={styles.signerIndex} aria-hidden="true">
              {i + 1}.
            </span>
            <StaffPicker
              label={`Recommended by ${i + 1}`}
              people={approverChoices(people, id)}
              emptyText={NO_APPROVERS}
              value={id}
              onChange={(userId) => onRecommenders(setRecommender(recommenders, i, userId))}
              open={exclusive.isOpen(`r${i}`)}
              onOpenChange={(open) => exclusive.setOpen(`r${i}`, open)}
              disabledIds={without(id)}
              inputRef={(el) => {
                inputs.current[i] = el;
              }}
            />
            <Tooltip content={`Remove recommender ${i + 1}`}>
              <button
                type="button"
                className={styles.remove}
                aria-label={`Remove recommender ${i + 1}`}
                onClick={() => {
                  onRecommenders(removeRecommender(recommenders, i));
                  exclusive.setOpen(`r${i}`, false);
                  setStatus(`Recommender ${i + 1} removed.`);
                  const next = focusAfterRemoval(i, recommenders.length);
                  pendingFocus.current = next === null ? 'add' : next;
                }}
              >
                <TrashIcon />
              </button>
            </Tooltip>
          </div>
        ))}
        <div className={styles.addRow}>
          <Button
            ref={addButton}
            type="button"
            variant="secondary"
            size="small"
            disabled={!canAddRecommender(recommenders)}
            onClick={() => {
              onRecommenders(addRecommender(recommenders));
              setStatus(`Recommender ${recommenders.length + 1} added.`);
              pendingFocus.current = recommenders.length;
            }}
          >
            <PlusIcon />
            Add recommender
          </Button>
          <span className={styles.signerHint}>
            {recommenders.length} of {MEMO_MAX_RECOMMENDERS} rows
            {canAddRecommender(recommenders) ? '' : '. That is the most a memo can name.'}
          </span>
        </div>
      </SignerGroup>

      <SignerGroup
        label="Approved by"
        hint={
          approverRule
            ? approverHint(approverRule)
            : noApprovers
              ? NO_APPROVERS
              : 'Only people who can decide approvals are listed.'
        }
      >
        <div className={styles.signerRow}>
          <StaffPicker
            label="Approved by"
            people={ruleApproverChoices(people, approverRule, approvedBy)}
            emptyText={approverRule?.blockReason ?? NO_APPROVERS}
            value={approvedBy}
            onChange={onApprovedBy}
            open={exclusive.isOpen('approved')}
            onOpenChange={(open) => exclusive.setOpen('approved', open)}
            disabledIds={without(approvedBy)}
          />
        </div>
      </SignerGroup>

      <p className={styles.signerHint}>Saving names does not approve or sign this memo.</p>
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
    </div>
  );
}
