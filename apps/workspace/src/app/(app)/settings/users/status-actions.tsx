'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
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

const KEEP_LOCKED = {
  label: 'Keep locked',
  description: (name: string) =>
    `${name} was locked after too many failed sign-ins and would be let back in when the lock runs out. Keep them locked and they stay locked until someone unlocks them.`,
};

/**
 * Deactivate, reactivate, lock or unlock one person (F1-Q5, F1-Q4). The API refuses your own account and the last
 * Founder. `canKeepLocked` is set on the unlock dialog of a person locked after failed sign-ins: it then also offers
 * "Keep locked" (the same lock action, so the lock never ends by itself).
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
  const copy = COPY[action];
  const [open, setOpen] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const offerKeep = canKeepLocked && action === 'unlock';

  async function run(apiAction: (typeof API_ACTION)[StatusActionKind]) {
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

  async function keepLocked() {
    setKeeping(true);
    try {
      if (await run('lock')) setOpen(false);
    } finally {
      setKeeping(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!keeping) setOpen(next);
      }}
      trigger={
        <Button variant="ghost" size="small" aria-label={`${copy.label} ${label}`}>
          {copy.label}
        </Button>
      }
      title={copy.title}
      description={copy.description(name)}
      confirmLabel={copy.confirm}
      destructive={action === 'deactivate' || action === 'lock'}
      onConfirm={() => run(API_ACTION[action])}
    >
      {offerKeep ? (
        <div>
          <p>{KEEP_LOCKED.description(name)}</p>
          <Button
            variant="secondary"
            size="small"
            disabled={keeping}
            aria-label={`${KEEP_LOCKED.label} ${label}`}
            onClick={() => void keepLocked()}
          >
            {KEEP_LOCKED.label}
          </Button>
        </div>
      ) : null}
    </ConfirmDialog>
  );
}
