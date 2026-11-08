'use client';

import { useActionState, useId, useState, useSyncExternalStore } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';

import styles from './crm.module.css';
import type { Move, MoveAction, MoveState } from './types';

const noopSubscribe = () => () => {};

/**
 * Move a lead or an opportunity to another stage. A real form with a native select and a submit
 * button, so it is the keyboard (and no-drag) way to move a card. Only the moves the server worked
 * out are offered; Lost and On Hold ask for a reason and a note before the button works.
 *
 * `presetStage` lets the board's drag-and-drop pick the stage; the person still presses Move, so a
 * slip of the mouse never changes a record.
 */
export function MoveForm({
  action,
  recordId,
  version,
  moves,
  presetStage,
  emptyText,
  compact = false,
  label = 'Move to',
}: {
  action: MoveAction;
  recordId: string;
  version: number;
  moves: Move[];
  presetStage?: string | undefined;
  /** Shown when no move is open from the current stage. */
  emptyText: string;
  compact?: boolean;
  label?: string;
}) {
  const [state, formAction, pending] = useActionState<MoveState, FormData>(action, {});
  const [stage, setStage] = useState(presetStage ?? moves[0]?.stage ?? '');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  // Until the page hydrates the reason fields stay visible, so the form still works as plain HTML.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
  const statusId = useId();

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
    if (!moves.some((m) => m.stage === stage)) setStage(moves[0]?.stage ?? '');
  }

  if (moves.length === 0) return <p className={styles.quiet}>{emptyText}</p>;

  const chosen = moves.find((m) => m.stage === stage);
  const needsReason = chosen?.needsReason ?? false;
  const showReason = !hydrated || needsReason;
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} noValidate className={compact ? styles.moveCompact : styles.moveForm}>
      <input type="hidden" name="recordId" value={recordId} />
      <input type="hidden" name="expectedVersion" value={version} />

      {state.error ? (
        <Alert tone="error" role="alert" id={statusId}>
          {state.error}
          {state.reload ? (
            <>
              {' '}
              <a href="">Reload this page</a>
            </>
          ) : null}
        </Alert>
      ) : state.ok ? (
        <p role="status" className={styles.moved}>
          Moved to {state.movedTo}.
        </p>
      ) : null}

      <Field label={label} error={errors['stage']}>
        {(control) => (
          <Select
            name="stage"
            value={stage}
            onChange={(e) => setStage(e.target.value)}
            {...control}
          >
            {moves.map((m) => (
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
