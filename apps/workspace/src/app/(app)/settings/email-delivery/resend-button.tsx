'use client';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

import { resendEmailAction } from './actions';

/** Resend for one failed or bounced email: asks first, then reports the result in a toast. */
export function ResendButton({
  id,
  subject,
  recipient,
}: {
  id: string;
  subject: string;
  recipient: string;
}) {
  return (
    <ConfirmDialog
      trigger={
        <Button variant="secondary" size="small" aria-label={`Resend "${subject}" to ${recipient}`}>
          Resend
        </Button>
      }
      title="Send this email again?"
      description={`"${subject}" goes to ${recipient} again, with a fresh set of attempts.`}
      confirmLabel="Resend email"
      onConfirm={async () => {
        const result = await resendEmailAction(id);
        if (result.status === 'ok') toast.success(result.message);
        else toast.error('Could not resend the email', { description: result.message });
      }}
    />
  );
}
