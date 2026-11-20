'use client';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

import type { MoveAction, MoveState } from './types';

export interface StageConfirmDialogProps {
  /** The stage-move server action (`moveLeadStageAction` or `moveOpportunityStageAction`). */
  action: MoveAction;
  id: string;
  /** The version the page shows; a stale one comes back as 409 and offers a reload. */
  version: number;
  /** Target stage code submitted to the stage action. */
  stage: string;
  triggerLabel: string;
  triggerVariant?: 'primary' | 'secondary' | undefined;
  title: string;
  description: string;
  confirmLabel: string;
  successMessage?: string | undefined;
  errorMessage?: string | undefined;
}

/**
 * Reusable confirmation dialog for plain stage moves that need no reason or activity (Resume,
 * Reopen, Requirement received, Proposal sent, Move to negotiation). Built on ConfirmDialog
 * (UIP-DLG-001) with toast feedback (UIP-FEED-001) and Reload action on 409.
 */
export function StageConfirmDialog({
  action,
  id,
  version,
  stage,
  triggerLabel,
  triggerVariant = 'primary',
  title,
  description,
  confirmLabel,
  successMessage,
  errorMessage,
}: StageConfirmDialogProps) {
  async function confirm() {
    const form = new FormData();
    form.set('recordId', id);
    form.set('expectedVersion', String(version));
    form.set('stage', stage);

    const result: MoveState = await action({}, form);
    if (!result.ok) {
      toast.error(
        result.error ??
          result.fieldErrors?.['stage'] ??
          errorMessage ??
          'The stage could not be updated.',
        result.reload
          ? { action: { label: 'Reload', onClick: () => window.location.reload() } }
          : undefined,
      );
      return false;
    }
    toast.success(successMessage ?? `Moved to ${result.movedTo ?? stage}.`);
    return true;
  }

  return (
    <ConfirmDialog
      trigger={<Button variant={triggerVariant}>{triggerLabel}</Button>}
      title={title}
      description={description}
      confirmLabel={confirmLabel}
      onConfirm={confirm}
    />
  );
}
