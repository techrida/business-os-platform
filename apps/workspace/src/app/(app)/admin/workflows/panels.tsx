'use client';

import { useActionState } from 'react';

import styles from '../admin.module.css';
import { IDLE, type ActionState } from '../action-state';
import { FormStatus } from '../ui';
import { addMemberAction, createDelegationAction, createGroupAction } from './actions';
import { UserField, type UserOption } from './user-field';

type ServerAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * A one-button form for a row action (publish, delete, remove, revoke). The Server Action is passed
 * in from the page. `confirmText` asks first for anything that is hard to undo.
 */
export function ActionButton({
  action,
  fields,
  label,
  hiddenLabel,
  variant = 'quiet',
  confirmText,
}: {
  action: ServerAction;
  fields: Record<string, string>;
  label: string;
  /** Extra words for screen readers, so "Remove" says who or what it removes. */
  hiddenLabel?: string;
  variant?: 'primary' | 'quiet' | 'danger';
  confirmText?: string;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const tone =
    variant === 'primary' ? '' : variant === 'danger' ? styles.btnDanger : styles.btnQuiet;
  return (
    <form
      action={formAction}
      className={styles.actions}
      onSubmit={(event) => {
        if (confirmText && !window.confirm(confirmText)) event.preventDefault();
      }}
    >
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <button
        type="submit"
        className={`${styles.btn} ${styles.btnSmall} ${tone}`}
        disabled={pending}
      >
        {label}
        {hiddenLabel ? <span className={styles.srOnly}> {hiddenLabel}</span> : null}
      </button>
      <FormStatus state={state} pending={pending} />
    </form>
  );
}

export function CreateGroupForm() {
  const [state, formAction, pending] = useActionState(createGroupAction, IDLE);
  const kept = state.status === 'error' ? (state.fields ?? {}) : {};
  return (
    <form action={formAction} className={styles.form}>
      <div className={styles.formRow}>
        <div className={styles.field}>
          <label htmlFor="group-name">Group name</label>
          <input
            id="group-name"
            className={styles.input}
            name="name"
            required
            autoComplete="off"
            defaultValue={kept.name ?? ''}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="group-key">Key</label>
          <input
            id="group-key"
            className={styles.input}
            name="key"
            required
            autoComplete="off"
            pattern="[a-z][a-z0-9_.\-]{0,63}"
            aria-describedby="group-key-hint"
            defaultValue={kept.key ?? ''}
          />
          <span id="group-key-hint" className={styles.hint}>
            Lowercase letters, digits, _ . - ; used by workflow steps.
          </span>
        </div>
      </div>
      <div className={styles.actions}>
        <button type="submit" className={styles.btn} disabled={pending}>
          Create group
        </button>
        <FormStatus state={state} pending={pending} />
      </div>
    </form>
  );
}

export function AddMemberForm({
  groupId,
  groupName,
  users,
}: {
  groupId: string;
  groupName: string;
  users: readonly UserOption[] | null;
}) {
  const [state, formAction, pending] = useActionState(addMemberAction, IDLE);
  return (
    <form action={formAction} className={styles.actions} style={{ alignItems: 'flex-end' }}>
      <input type="hidden" name="groupId" value={groupId} />
      <UserField
        id={`member-${groupId}`}
        name="userId"
        label={`Add a member to ${groupName}`}
        users={users}
      />
      <button type="submit" className={`${styles.btn} ${styles.btnSmall}`} disabled={pending}>
        Add
      </button>
      <FormStatus state={state} pending={pending} />
    </form>
  );
}

export function DelegationForm({
  users,
  documentTypes,
}: {
  users: readonly UserOption[] | null;
  documentTypes: readonly string[];
}) {
  const [state, formAction, pending] = useActionState(createDelegationAction, IDLE);
  const kept = state.status === 'error' ? (state.fields ?? {}) : {};
  return (
    <form action={formAction} className={styles.form}>
      <div className={styles.formRow}>
        <UserField
          id="deleg-from"
          name="fromUserId"
          label="Handing over (from)"
          users={users}
          defaultValue={kept.fromUserId ?? ''}
        />
        <UserField
          id="deleg-to"
          name="toUserId"
          label="Taking over (to)"
          users={users}
          defaultValue={kept.toUserId ?? ''}
        />
      </div>
      <div className={styles.formRow}>
        <div className={styles.field}>
          <label htmlFor="deleg-start">Starts</label>
          <input
            id="deleg-start"
            className={styles.input}
            type="datetime-local"
            name="startsAt"
            required
            defaultValue={kept.startsAt ?? ''}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="deleg-end">Ends</label>
          <input
            id="deleg-end"
            className={styles.input}
            type="datetime-local"
            name="endsAt"
            required
            defaultValue={kept.endsAt ?? ''}
          />
        </div>
        <div className={styles.field}>
          <label htmlFor="deleg-doc">Document type (optional)</label>
          <input
            id="deleg-doc"
            className={styles.input}
            name="documentType"
            list="deleg-doc-types"
            autoComplete="off"
            placeholder="All documents"
            defaultValue={kept.documentType ?? ''}
          />
          <datalist id="deleg-doc-types">
            {documentTypes.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
        </div>
      </div>
      <p className={styles.hint}>
        Times are Nepal time (UTC+05:45). While it runs, the person taking over can act on steps
        that were meant for the person handing over.
      </p>
      <div className={styles.actions}>
        <button type="submit" className={styles.btn} disabled={pending}>
          Create delegation
        </button>
        <FormStatus state={state} pending={pending} />
      </div>
    </form>
  );
}
