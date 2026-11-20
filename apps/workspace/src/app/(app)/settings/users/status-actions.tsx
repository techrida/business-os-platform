'use client';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

import { changeUserStatusAction } from './actions';

/** `keepLocked` is the lock action on a person already locked after failed sign-ins (the lock then never ends). */
export type StatusActionKind = 'deactivate' | 'reactivate' | 'lock' | 'keepLocked' | 'unlock';

const API_ACTION = {
  deactivate: 'deactivate',
  reactivate: 'reactivate',
  lock: 'lock',
  keepLocked: 'lock',
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
  keepLocked: {
    label: 'Keep locked',
    title: 'Keep this user locked?',
    description: (name) =>
      `${name} was locked after too many failed sign-ins. They stay locked until someone unlocks them, instead of being let back in when the lock runs out.`,
    confirm: 'Keep locked',
  },
  unlock: {
    label: 'Unlock',
    title: 'Unlock this user?',
    description: (name) => `${name} can sign in again with their existing roles.`,
    confirm: 'Unlock',
  },
};

/**
 * Deactivate, reactivate, lock or unlock one person (F1-Q5, F1-Q4). The API refuses your own account and the last
 * Founder.
 */
export function StatusAction({
  userId,
  name,
  label,
  action,
}: {
  userId: string;
  /** The person's display name, for the dialog text. */
  name: string;
  /** Tells rows apart for screen readers (name and email). */
  label: string;
  action: StatusActionKind;
}) {
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
      destructive={action === 'deactivate' || action === 'lock' || action === 'keepLocked'}
      onConfirm={async () => {
        try {
          const result = await changeUserStatusAction(userId, API_ACTION[action]);
          if (result.status === 'ok') {
            toast.success(result.message);
            return true;
          }
          if (result.status === 'error') toast.error(result.message);
        } catch {
          toast.error('Could not confirm the change. Reload the page to see the current status.');
        }
        return false;
      }}
    />
  );
}
