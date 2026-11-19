'use client';

import {
  LEAD_LOST_REASON_LABEL_MAX,
  LOST_REASONS_STALE_MESSAGE,
  lostReasonsToken,
  type LeadLostReason,
} from '@bos/contracts';
import { useId, useState, useTransition, type FormEvent } from 'react';

import {
  addLostReasonAction,
  renameLostReasonAction,
  reorderLostReasonsAction,
  resetLostReasonsAction,
  setLostReasonRetiredAction,
} from '@/app/(app)/settings/sales/actions';
import type { ActionState } from '@/app/(app)/settings/action-state';
import { ResetToDefaultButton } from '@/components/settings/reset-to-default';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';

import { isDefaultList, labelProblem, movedOrder } from './lost-reasons-model';
import styles from './lost-reasons.module.css';

/**
 * The Founder's Lost reasons card (D49, D54-3, D54-4): the shared list Mark lost offers for leads
 * and opportunities, in order. Each reason can be renamed, moved up or down, and retired or
 * restored; a new one is added at the end, and Reset puts the seven defaults back (D32). A retired
 * reason is hidden from Mark lost but stays on the leads and opportunities that carry it, so
 * nothing is deleted. Reorder and Reset send the displayed list's token (`lostReasonsToken`), so a
 * stale screen never overwrites someone else's change.
 */
export function LostReasonsCard({ reasons }: { reasons: readonly LeadLostReason[] }) {
  const ordered = [...reasons].sort((a, b) => a.position - b.position);
  const expectedOrder = lostReasonsToken(ordered);
  const [pending, startTransition] = useTransition();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  const [adding, setAdding] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const addId = useId();

  /** Runs one action: a toast says what happened, and `onOk` runs only when it worked. */
  function run(action: () => Promise<ActionState>, onOk?: () => void) {
    startTransition(async () => {
      try {
        const state = await action();
        if (state.status === 'error') {
          if (state.message === LOST_REASONS_STALE_MESSAGE) {
            toast.error(state.message, {
              action: { label: 'Reload', onClick: () => window.location.reload() },
            });
          } else {
            toast.error(state.message);
          }
          return;
        }
        toast.success(state.message);
        onOk?.();
      } catch {
        toast.error('That change could not be saved. Try again.');
      }
    });
  }

  function startRename(reason: LeadLostReason) {
    setEditing(reason.id);
    setDraft(reason.label);
    setEditError(null);
  }

  function saveRename(event: FormEvent<HTMLFormElement>, reason: LeadLostReason) {
    event.preventDefault();
    if (pending) return;
    const problem = labelProblem(draft, ordered, reason.id);
    setEditError(problem);
    if (problem) return;
    if (draft.trim() === reason.label) {
      setEditing(null);
      return;
    }
    run(
      () => renameLostReasonAction(reason.id, draft.trim(), reason.version),
      () => setEditing(null),
    );
  }

  function add(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const problem = labelProblem(adding, ordered);
    setAddError(problem);
    if (problem) return;
    run(
      () => addLostReasonAction(adding.trim()),
      () => setAdding(''),
    );
  }

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <p className={styles.hint}>
          Offered when a lead or opportunity is marked lost, in this order. Renaming a reason
          renames it on every lead and opportunity that used it. A retired reason is no longer
          offered but stays on the leads and opportunities that have it.
        </p>
        <ResetToDefaultButton
          section="sales"
          settingKey="lead_lost_reasons"
          label="the lost reasons"
          isDefault={isDefaultList(ordered)}
          defaultText="the 7 app default reasons"
          action={() => resetLostReasonsAction(expectedOrder)}
          reloadOnMessage={LOST_REASONS_STALE_MESSAGE}
          confirm={{
            title: 'Reset the lost reasons to default?',
            body: 'The seven default reasons come back with their names, order and active state. Reasons you added are retired and listed after them. Leads and opportunities keep the reason they were closed with.',
            confirmLabel: 'Reset lost reasons',
          }}
        />
      </div>

      <ol className={styles.list} aria-label="Lost reasons">
        {ordered.map((reason, index) => (
          <li key={reason.id} className={styles.row} data-retired={reason.retired || undefined}>
            {editing === reason.id ? (
              <form className={styles.edit} noValidate onSubmit={(e) => saveRename(e, reason)}>
                <Field label={`Name of ${reason.label}`} error={editError}>
                  {(control) => (
                    <Input
                      {...control}
                      value={draft}
                      maxLength={LEAD_LOST_REASON_LABEL_MAX}
                      onChange={(e) => setDraft(e.target.value)}
                      autoFocus
                    />
                  )}
                </Field>
                <div className={styles.actions}>
                  <Button type="submit" size="small" disabled={pending}>
                    Save
                  </Button>
                  <Button
                    type="button"
                    size="small"
                    variant="secondary"
                    disabled={pending}
                    onClick={() => setEditing(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <div className={styles.nameLine}>
                  <span className={styles.name}>{reason.label}</span>
                  {reason.isDefault ? <Badge>App default</Badge> : null}
                  {reason.retired ? <Badge tone="warning">Retired</Badge> : null}
                </div>
                <div className={styles.actions}>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={pending || index === 0}
                    aria-label={`Move ${reason.label} up`}
                    onClick={() =>
                      run(() =>
                        reorderLostReasonsAction(
                          movedOrder(ordered, reason.id, 'up'),
                          expectedOrder,
                        ),
                      )
                    }
                  >
                    Up
                  </Button>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={pending || index === ordered.length - 1}
                    aria-label={`Move ${reason.label} down`}
                    onClick={() =>
                      run(() =>
                        reorderLostReasonsAction(
                          movedOrder(ordered, reason.id, 'down'),
                          expectedOrder,
                        ),
                      )
                    }
                  >
                    Down
                  </Button>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={pending}
                    aria-label={`Rename ${reason.label}`}
                    onClick={() => startRename(reason)}
                  >
                    Rename
                  </Button>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={pending}
                    aria-label={`${reason.retired ? 'Restore' : 'Retire'} ${reason.label}`}
                    onClick={() =>
                      run(() =>
                        setLostReasonRetiredAction(reason.id, !reason.retired, reason.version),
                      )
                    }
                  >
                    {reason.retired ? 'Restore' : 'Retire'}
                  </Button>
                </div>
              </>
            )}
          </li>
        ))}
      </ol>

      <form className={styles.add} noValidate onSubmit={add}>
        <Field label="Add a reason" error={addError} className={styles.addField ?? ''}>
          {(control) => (
            <Input
              {...control}
              id={addId}
              value={adding}
              maxLength={LEAD_LOST_REASON_LABEL_MAX}
              placeholder="For example, Slow to reply"
              onChange={(e) => setAdding(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
          Add reason
        </Button>
      </form>
    </div>
  );
}
