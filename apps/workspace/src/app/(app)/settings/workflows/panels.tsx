'use client';

import { useActionState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';
import { Field, Input, Textarea } from '@/components/ui/field';
import { SuggestInput } from '@/components/ui/suggest-input';

import adminStyles from '../admin.module.css';
import { IDLE, type ActionState } from '../action-state';
import { FormStatus } from '../ui';
import { addMemberAction, createDelegationAction, createGroupAction } from './actions';
import { UserField, type UserOption } from './user-field';
import styles from './workflows.module.css';

type ServerAction = (previous: ActionState, formData: FormData) => Promise<ActionState>;

type RowVariant = 'primary' | 'quiet' | 'danger' | 'dangerOutline';

const LOOK: Record<
  RowVariant,
  { variant: 'primary' | 'secondary' | 'ghost'; className: string | undefined }
> = {
  primary: { variant: 'primary', className: undefined },
  quiet: { variant: 'secondary', className: undefined },
  // Remove: a quiet red text button, so a list of members is not a column of red outlines.
  danger: { variant: 'ghost', className: adminStyles.danger },
  // Revoke, Delete: the same red, with an outline so it reads as a decision.
  dangerOutline: {
    variant: 'secondary',
    className: `${adminStyles.danger ?? ''} ${adminStyles.dangerOutline ?? ''}`.trim(),
  },
};

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
  variant?: RowVariant;
  confirmText?: string;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  const look = LOOK[variant];
  const button = (
    <Button
      type={confirmText ? 'button' : 'submit'}
      variant={look.variant}
      size="small"
      className={look.className}
      disabled={pending}
    >
      {label}
      {hiddenLabel ? <span className="sr-only"> {hiddenLabel}</span> : null}
    </Button>
  );
  if (confirmText) {
    return (
      <ConfirmDialog
        trigger={button}
        title={hiddenLabel ? `${label} ${hiddenLabel}?` : `${label}?`}
        description={confirmText}
        confirmLabel={label}
        destructive={variant === 'danger' || variant === 'dangerOutline'}
        onConfirm={async () => {
          const data = new FormData();
          for (const [name, value] of Object.entries(fields)) data.set(name, value);
          try {
            const result = await action(IDLE, data);
            if (result.status === 'error') {
              toast.error(result.message);
              return false;
            }
            toast.success(result.message);
            return true;
          } catch {
            toast.error('Could not confirm the change. Refresh to check its status.');
            return false;
          }
        }}
      />
    );
  }
  return (
    <form action={formAction} className={styles.rowAction}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {button}
      <FormStatus state={state} pending={pending} />
    </form>
  );
}

/**
 * Publish for the small-team rule (F1-Q11 a): the caller saved this draft and nobody else may publish it,
 * so they may, with a reason the API audits. The reason box replaces the usual confirm dialog, and the
 * sentence that dialog would show sits beside it.
 */
export function SoleEligiblePublishForm({
  action,
  fields,
  hiddenLabel,
}: {
  action: ServerAction;
  fields: Record<string, string>;
  hiddenLabel?: string;
}) {
  const [state, formAction, pending] = useActionState(action, IDLE);
  return (
    <form action={formAction} className={styles.form}>
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <span className={styles.hint}>
        You are the only person who can publish this; a reason is required.
      </span>
      <Field
        label="Reason for publishing"
        hint="New requests will use this version, and the version in use will be retired."
      >
        {(control) => <Textarea {...control} name="reason" required maxLength={500} rows={2} />}
      </Field>
      <div className={styles.formActions}>
        <Button type="submit" variant="primary" size="small" disabled={pending}>
          Publish
          {hiddenLabel ? <span className="sr-only"> {hiddenLabel}</span> : null}
        </Button>
      </div>
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
        <Field label="Group name">
          {(control) => (
            <Input
              {...control}
              name="name"
              required
              autoComplete="off"
              defaultValue={kept.name ?? ''}
            />
          )}
        </Field>
        <Field label="Key" hint="Lowercase letters, digits, _ . - ; used by workflow steps.">
          {(control) => (
            <Input
              {...control}
              name="key"
              required
              autoComplete="off"
              pattern="[a-z][a-z0-9_.\-]{0,63}"
              defaultValue={kept.key ?? ''}
            />
          )}
        </Field>
      </div>
      <div className={styles.formActions}>
        <Button type="submit" disabled={pending}>
          Create group
        </Button>
      </div>
      <FormStatus state={state} pending={pending} />
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
    <form action={formAction} className={styles.form}>
      <input type="hidden" name="groupId" value={groupId} />
      <div className={styles.addRow}>
        <UserField
          name="userId"
          label={
            <>
              Add a member<span className="sr-only"> to {groupName}</span>
            </>
          }
          users={users}
        />
        <Button type="submit" variant="secondary" disabled={pending || !users?.length}>
          Add
        </Button>
      </div>
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
          name="fromUserId"
          label="Handing over (from)"
          users={users}
          defaultValue={kept.fromUserId ?? ''}
        />
        <UserField
          name="toUserId"
          label="Taking over (to)"
          users={users}
          defaultValue={kept.toUserId ?? ''}
        />
      </div>
      <div className={styles.formRow}>
        <Field label="Starts">
          {(control) => (
            <Input
              {...control}
              type="datetime-local"
              name="startsAt"
              required
              defaultValue={kept.startsAt ?? ''}
            />
          )}
        </Field>
        <Field label="Ends">
          {(control) => (
            <Input
              {...control}
              type="datetime-local"
              name="endsAt"
              required
              defaultValue={kept.endsAt ?? ''}
            />
          )}
        </Field>
        <Field label="Document type (optional)">
          {(control) => (
            <SuggestInput
              {...control}
              name="documentType"
              suggestions={documentTypes}
              autoComplete="off"
              placeholder="All documents"
              defaultValue={kept.documentType ?? ''}
            />
          )}
        </Field>
      </div>
      <p className={styles.hint}>
        Times are Nepal time (UTC+05:45). While it runs, the person taking over can act on steps
        that were meant for the person handing over.
      </p>
      <div className={styles.formActions}>
        <Button type="submit" disabled={pending || !users?.length}>
          Create delegation
        </Button>
      </div>
      <FormStatus state={state} pending={pending} />
    </form>
  );
}
