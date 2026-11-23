'use client';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

import { resolveIdentityAction } from '../actions';

/**
 * Resolve one flagged person: the API reads the identity provider again, then in one transaction copies what it holds
 * (status, lock, roles) into BOS and clears the flag. A 503 or 409 comes back as the message and the flag stays.
 */
export function ResolveButton({
  userId,
  name,
  label,
}: {
  userId: string;
  name: string;
  label: string;
}) {
  return (
    <ConfirmDialog
      trigger={
        <Button variant="secondary" size="small" aria-label={`Resolve ${label}`}>
          Resolve
        </Button>
      }
      title="Resolve this flag?"
      description={`BOS reads ${name}’s account in the identity provider again and copies its status, lock and roles here, then clears the flag. If the identity provider cannot be read, nothing changes and the flag stays. Fix the identity provider first if it is wrong.`}
      confirmLabel="Resolve"
      onConfirm={async () => {
        try {
          const result = await resolveIdentityAction(userId);
          if (result.status === 'ok') {
            toast.success(result.message);
            return true;
          }
          if (result.status === 'error') toast.error(result.message);
        } catch {
          toast.error('Could not confirm the change. Reload the page to see the current state.');
        }
        return false;
      }}
    />
  );
}
