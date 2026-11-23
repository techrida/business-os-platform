'use client';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import { toast } from '@/components/ui/toast';

import { sendPasswordResetAction } from './actions';
import { Tooltip } from '@/components/ui/tooltip';

export function PasswordReset({
  userId,
  label,
  email,
}: {
  userId: string;
  label: string;
  email: string;
}) {
  return (
    <ConfirmDialog
      trigger={
        <Tooltip content="Send password reset email">
          <Button variant="ghost" size="small" aria-label={`Send password reset email to ${label}`}>
            <Icon name="mail" size={20} />
          </Button>
        </Tooltip>
      }
      title="Send a password reset email?"
      description={`A link to choose a new password will be sent to ${email}.`}
      confirmLabel="Send email"
      onConfirm={async () => {
        try {
          const result = await sendPasswordResetAction(userId);
          if (result.status === 'ok') {
            toast.success(result.message);
            return true;
          }
          if (result.status === 'error') toast.error(result.message);
        } catch {
          toast.error('Could not confirm the password reset request.');
        }
        return false;
      }}
    />
  );
}
