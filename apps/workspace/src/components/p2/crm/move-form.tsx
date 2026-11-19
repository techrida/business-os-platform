'use client';

import { useActionState, useEffect, useId, useState, useSyncExternalStore } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';

import styles from './crm.module.css';
import type { Move, MoveAction, MoveState } from './types';

const noopSubscribe = () => () => {};

/** Announce a stage move's outcome. Field errors also stay inline; a stale page keeps its alert. */
export function toastMoveResult(state: MoveState, id: string): void {
  if (state.ok) toast.success(`Moved to ${state.movedTo}.`, { id });
  else if (state.error && !state.reload) toast.error(state.error, { id });
  else if (state.fieldErrors) toast.error('Check the highlighted fields.', { id });
}

/**
 * Move a lead or an opportunity to another stage. A real form with a native select and a submit
 * button, so it is the keyboard (and no-drag) way to move a card. Only the moves the server worked
 * out are offered; Lost and On Hold ask for a reason and a note before the button works.
 *
 * `presetStage` lets the board's drag-and-drop pick the stage; the person still presses Move, so a
 * slip of the mouse never changes a record.
 *
 * `exclude` drops targets another control owns, so one transition never has two controls: the lead
 * page passes `['qualified', 'lost', 'converted']` because its header has Qualify and Mark lost and
 * Convert has its own card. When nothing is left, `emptyText` shows instead of the form.
 */
export function MoveForm({
  action,
  recordId,
  version,
  moves,
  presetStage,
  exclude,
  emptyText,
  compact = false,
  label = 'Move to',
  toasts = true,
}: {
  action: MoveAction;
  recordId: string;
  version: number;
  moves: Move[];
  presetStage?: string | undefined;
  /** Stages left out of the list because another control on the page makes that move. */
  exclude?: readonly string[] | undefined;
  /** Shown when no move is open from the current stage (after `exclude`). */
  emptyText: string;
  compact?: boolean;
  label?: string;
  /** False when the caller toasts the result itself (the board). */
  toasts?: boolean;
}) {
  const [state, formAction, pending] = useActionState<MoveState, FormData>(action, {});
  const offered = exclude ? moves.filter((m) => !exclude.includes(m.stage)) : moves;
  const [stage, setStage] = useState(presetStage ?? offered[0]?.stage ?? '');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const statusId = useId();
  // The board passes its own toasting action (`toasts={false}`): a successful move re-renders the
  // card in another column, so this instance unmounts before an effect could announce it.
  useEffect(() => {
    if (!toasts) return;
    toastMoveResult(state, statusId);
  }, [state, statusId, toasts]);
  // Until the page hydrates the reason fields stay visible, so the form still works as plain HTML.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

  // Adjust state while rendering when a prop changes (React's pattern for derived state): the
  // board's drop picks a stage, and a new version means the record moved, so start the form clean.
  const [seenPreset, setSeenPreset] = useState(presetStage);
  if (presetStage !== seenPreset) {
    setSeenPreset(presetStage);
    if (presetStage !== undefined) setStage(presetStage);
  }
  const [seenVersion, setSeenVersion] = useState(version);
  if (version !== seenVersion) {
    setSeenVersion(version);
    setReason('');
    setNote('');
    if (!offered.some((m) => m.stage === stage)) setStage(offered[0]?.stage ?? '');
  }

  if (offered.length === 0) return <p className={styles.quiet}>{emptyText}</p>;

  const chosen = offered.find((m) => m.stage === stage);
  const needsReason = chosen?.needsReason ?? false;
  const showReason = !hydrated || needsReason;
  const errors = state.fieldErrors ?? {};

  return (
    <form
      action={formAction}
      noValidate
      className={compact ? styles.moveCompact : styles.moveForm}
      data-needs-reason={showReason || undefined}
    >
      <input type="hidden" name="recordId" value={recordId} />
      <input type="hidden" name="expectedVersion" value={version} />

      {state.error && state.reload ? (
        <Alert tone="error" role="alert" id={statusId}>
          {state.error} <a href="">Reload this page</a>
        </Alert>
      ) : null}

      <Field label={label} error={errors['stage']}>
        {(control) => (
          <Select
            name="stage"
            value={stage}
            onChange={(e) => setStage(e.target.value)}
            {...control}
          >
            {offered.map((m) => (
              <option key={m.stage} value={m.stage}>
                {m.label}
                {m.needsReason ? ' (needs a reason)' : ''}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {showReason ? (
        <>
          <Field
            label="Reason"
            hint={hydrated ? undefined : 'Needed for Lost and On Hold.'}
            error={errors['reason']}
          >
            {(control) => (
              <Input
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={200}
                required={needsReason}
                {...control}
              />
            )}
          </Field>
          <Field label="Note" error={errors['note']}>
            {(control) => (
              <Textarea
                name="note"
                rows={3}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                required={needsReason}
                {...control}
              />
            )}
          </Field>
        </>
      ) : null}

      <div>
        <Button type="submit" size={compact ? 'small' : 'medium'} disabled={pending}>
          {pending ? 'Moving' : 'Move'}
        </Button>
      </div>
    </form>
  );
}
