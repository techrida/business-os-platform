'use client';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

import { changeUserStatusAction } from './actions';

type Action = 'deactivate' | 'reactivate';

const COPY: Record<
  Action,
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
};

/** Deactivate or reactivate one person (F1-Q5). The API refuses your own account and the last Founder. */
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
  action: Action;
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
      destructive={action === 'deactivate'}
      onConfirm={async () => {
        try {
          const result = await changeUserStatusAction(userId, action);
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
