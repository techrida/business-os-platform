'use client';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

import { moveLeadStageAction } from './actions';

/**
 * The Qualify header action (D41): a plain confirm, because the stage rules ask for no reason or
 * note on the way into Qualified. The fixed footer comes from ConfirmDialog (UIP-DLG-001); the
 * outcome is a toast (UIP-FEED-001), and a stale page (409) keeps the dialog open with a Reload.
 */
export function QualifyLead({
  id,
  number,
  version,
  size,
}: {
  id: string;
  number: string;
  version: number;
  size?: 'small';
}) {
  async function qualify() {
    const form = new FormData();
    form.set('recordId', id);
    form.set('expectedVersion', String(version));
    form.set('stage', 'qualified');

    const result = await moveLeadStageAction({}, form);
    if (!result.ok) {
      toast.error(
        result.error ?? result.fieldErrors?.['stage'] ?? 'The lead could not be qualified.',
        result.reload
          ? { action: { label: 'Reload', onClick: () => window.location.reload() } }
          : undefined,
      );
      return false;
    }
    toast.success('Moved to Qualified.');
    return true;
  }

  return (
    <ConfirmDialog
      trigger={
        <Button variant="secondary" size={size}>
          Qualify
        </Button>
      }
      title="Qualify this lead?"
      description={`${number} will move from Contacted to Qualified. You can then convert it to an opportunity.`}
      confirmLabel="Qualify lead"
      onConfirm={qualify}
    />
  );
}
