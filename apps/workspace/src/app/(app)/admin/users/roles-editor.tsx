'use client';

import { useActionState, useId, useRef, useState, type MouseEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

import { IDLE, type ActionState } from '../action-state';
import { FormStatus } from '../ui';
import { setRolesAction } from './actions';
import { RoleCheckboxes } from './role-checkboxes';
import styles from './users.module.css';

/**
 * "Edit roles" for one user: a button that opens a native modal dialog. The browser traps focus in
 * it, closes it on Esc and puts focus back on the button. The label names the person, so each
 * button is distinct for screen reader users. The dialog stays open after a save so the result
 * is announced where the admin is looking; Close dismisses it.
 */
export function RolesEditor({
  userId,
  label,
  roles,
}: {
  userId: string;
  label: string;
  roles: readonly string[];
}) {
  const [state, formAction, pending] = useActionState(setRolesAction, IDLE);
  // The ticked roles live here (controlled), so a refused save keeps them: React resets
  // uncontrolled fields after every action.
  const [selected, setSelected] = useState<string[]>([...roles]);
  // The result we have already shown. useActionState cannot be reset, so reopening the dialog
  // hides a result from an earlier opening.
  const [seen, setSeen] = useState<ActionState | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const subId = useId();
  const visible = state === seen ? IDLE : state;

  const open = () => {
    setSelected([...roles]);
    setSeen(state);
    dialogRef.current?.showModal();
  };
  const close = () => dialogRef.current?.close();
  // A click on the dim area outside the box (the dialog has no padding, so only the backdrop
  // reports itself as the target). Esc and the buttons are the keyboard routes.
  const closeOnBackdrop = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target === event.currentTarget) close();
  };
  const toggle = (role: string, on: boolean) =>
    setSelected((current) =>
      on
        ? current.includes(role)
          ? current
          : [...current, role]
        : current.filter((r) => r !== role),
    );

  return (
    <>
      <Button variant="secondary" size="small" onClick={open}>
        Edit roles<span className="sr-only"> for {label}</span>
      </Button>
      <dialog
        ref={dialogRef}
        className={styles.dialog}
        aria-labelledby={titleId}
        aria-describedby={subId}
        onClick={closeOnBackdrop}
      >
        <form action={formAction} className={styles.dialogForm}>
          <input type="hidden" name="userId" value={userId} />
          <div className={styles.dialogHead}>
            <div className={styles.dialogTitle}>
              <h2 id={titleId}>Edit roles</h2>
              <p id={subId} className={styles.dialogSub}>
                {label}
              </p>
            </div>
            <Button
              variant="ghost"
              size="small"
              className={styles.dialogClose ?? ''}
              onClick={close}
              aria-label="Close"
            >
              <Icon name="x" size={18} />
            </Button>
          </div>
          <div className={styles.dialogBody}>
            <RoleCheckboxes
              idPrefix={`roles-${userId}`}
              legend={`Roles for ${label}`}
              hideLegend
              checked={selected}
              onToggle={toggle}
            />
            <FormStatus state={visible} pending={pending} />
          </div>
          <div className={styles.dialogFoot}>
            <Button variant="secondary" onClick={close}>
              {visible.status === 'ok' ? 'Close' : 'Cancel'}
            </Button>
            <Button type="submit" disabled={pending}>
              Save roles
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
