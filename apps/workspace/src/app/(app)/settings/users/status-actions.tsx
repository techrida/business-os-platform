'use client';

import { useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog, Dialog } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

import { changeUserStatusAction } from './actions';

export type StatusActionKind = 'deactivate' | 'reactivate' | 'lock' | 'unlock';

const API_ACTION = {
  deactivate: 'deactivate',
  reactivate: 'reactivate',
  lock: 'lock',
  unlock: 'unlock',
} as const;

const COPY: Record<
  StatusActionKind,
  { label: string; title: string; description: (name: string) => string; confirm: string }
> = {
  deactivate: {
    label: 'Deactivate',
    title: 'Deactivate this user?',
    description: (name) =>
      `${name} is signed out and cannot sign in until someone reactivates them. Their records stay as they are.`,
    confirm: 'Deactivate',
  },
  reactivate: {
    label: 'Reactivate',
    title: 'Reactivate this user?',
    description: (name) => `${name} can sign in again with their existing roles.`,
    confirm: 'Reactivate',
  },
  lock: {
    label: 'Lock',
    title: 'Lock this user?',
    description: (name) =>
      `${name} is signed out and cannot sign in until someone unlocks them. Their records stay as they are.`,
    confirm: 'Lock',
  },
  unlock: {
    label: 'Unlock',
    title: 'Unlock this user?',
    description: (name) => `${name} can sign in again with their existing roles.`,
    confirm: 'Unlock',
  },
};

/** Runs one status change and shows its toast. Resolves true when the change was made. */
async function runStatus(userId: string, apiAction: (typeof API_ACTION)[StatusActionKind]) {
  try {
    const result = await changeUserStatusAction(userId, apiAction);
    if (result.status === 'ok') {
      toast.success(result.message);
      return true;
    }
    if (result.status === 'error') toast.error(result.message);
  } catch {
    toast.error('Could not confirm the change. Reload the page to see the current status.');
  }
  return false;
}

/**
 * The lock dialog of a person locked after failed sign-ins (the lock would end by itself). One dialog, one busy
 * state: Cancel, Keep locked and Unlock are all off while either request runs, and focus starts on Cancel so Enter
 * confirms nothing. Keep locked is the same `lock` action the Users row used to offer on its own.
 */
function UnlockOrKeepLocked({
  userId,
  name,
  label,
}: {
  userId: string;
  name: string;
  label: string;
}) {
  const copy = COPY.unlock;
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);

  async function choose(apiAction: 'lock' | 'unlock') {
    setPending(true);
    try {
      if (await runStatus(userId, apiAction)) setOpen(false);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      trigger={
        <Button variant="ghost" size="small" aria-label={`${copy.label} ${label}`}>
          {copy.label}
        </Button>
      }
      title={copy.title}
      description={`${name} was locked after too many failed sign-ins. Unlock lets them sign in again with their existing roles. Keep locked makes the lock permanent: they stay locked until someone unlocks them, instead of being let back in when the lock runs out.`}
      size="small"
      locked={pending}
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button
            ref={cancelRef}
            variant="secondary"
            disabled={pending}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            variant="secondary"
            disabled={pending}
            aria-label={`Keep locked ${label}`}
            onClick={() => void choose('lock')}
          >
            Keep locked
          </Button>
          <Button disabled={pending} aria-busy={pending || undefined} onClick={() => void choose('unlock')}>
            {copy.confirm}
          </Button>
        </>
      }
    />
  );
}

/**
 * Deactivate, reactivate, lock or unlock one person (F1-Q5, F1-Q4). The API refuses your own account and the last
 * Founder. `canKeepLocked` is set for the unlock of a person locked after failed sign-ins: the dialog then also
 * offers "Keep locked".
 */
export function StatusAction({
  userId,
  name,
  label,
  action,
  canKeepLocked = false,
}: {
  userId: string;
  /** The person's display name, for the dialog text. */
  name: string;
  /** Tells rows apart for screen readers (name and email). */
  label: string;
  action: StatusActionKind;
  canKeepLocked?: boolean;
}) {
  if (action === 'unlock' && canKeepLocked) {
    return <UnlockOrKeepLocked userId={userId} name={name} label={label} />;
  }
  const copy = COPY[action];
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="small" aria-label={`${copy.label} ${label}`}>
          {copy.label}
        </Button>
      }
      title={copy.title}
      description={copy.description(name)}
      confirmLabel={copy.confirm}
      destructive={action === 'deactivate' || action === 'lock'}
      onConfirm={() => runStatus(userId, API_ACTION[action])}
    />
  );
}
