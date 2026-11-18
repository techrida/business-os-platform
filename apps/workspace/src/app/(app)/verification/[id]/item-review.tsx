'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';
import { itemAction, removeLooseAction } from './item-actions';

export function ItemReview({
  caseId,
  itemKey,
  label,
  version,
  canApprove,
}: {
  caseId: string;
  itemKey: string;
  label: string;
  version: number;
  canApprove: boolean;
}) {
  const router = useRouter();
  const hintId = useId();
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [open, setOpen] = useState(false);
  const busy = useRef(false);
  const retry = useRef({ approve: '', reject: '' });
  async function decide(intent: 'approve' | 'reject') {
    if (busy.current || (intent === 'approve' && !canApprove)) return false;
    if (intent === 'reject' && !reason.trim()) {
      toast.error('Enter a rejection reason');
      return false;
    }
    busy.current = true;
    setPending(true);
    const key = (retry.current[intent] ||= crypto.randomUUID());
    const form = new FormData();
    for (const [field, value] of Object.entries({
      caseId,
      itemKey,
      expectedVersion: String(version),
      intent,
      comment: reason,
      idempotencyKey: key,
    }))
      form.set(field, value);
    try {
      const result = await itemAction({ key }, form);
      retry.current[intent] = result.key;
      if (!result.done) {
        toast.error(result.errors?.comment ?? result.error ?? 'The decision could not be saved.');
        return false;
      }
      toast.success(intent === 'approve' ? 'Document approved' : 'Document rejected');
      router.refresh();
      return true;
    } catch {
      toast.error('The decision could not be confirmed. Try again.');
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return (
    <div>
      <Button
        size="small"
        variant="secondary"
        aria-label={`Approve ${label}`}
        aria-disabled={!canApprove || pending}
        aria-describedby={!canApprove ? hintId : undefined}
        onClick={() => void decide('approve')}
      >
        Approve
      </Button>
      {!canApprove && <span id={hintId}>Approval requires a clean, unexpired file.</span>}
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setReason('');
        }}
        trigger={
          <Button size="small" variant="ghost" disabled={pending} aria-label={`Reject ${label}`}>
            Reject
          </Button>
        }
        title={`Reject ${label}?`}
        description="Sales will see your reason."
        destructive
        confirmLabel="Reject document"
        onConfirm={() => decide('reject')}
      >
        <Field label="Rejection reason">
          {(control) => (
            <Textarea
              {...control}
              required
              maxLength={2000}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={4}
            />
          )}
        </Field>
      </ConfirmDialog>
    </div>
  );
}

export function RemoveLoose({
  caseId,
  documentId,
  filename,
}: {
  caseId: string;
  documentId: string;
  filename: string;
}) {
  const router = useRouter();
  async function remove() {
    const form = new FormData();
    form.set('caseId', caseId);
    form.set('documentId', documentId);
    try {
      const result = await removeLooseAction({ key: documentId }, form);
      if (result.error) {
        toast.error(result.error);
        return false;
      }
      toast.success('File removed');
      router.refresh();
      return true;
    } catch {
      toast.error('Removal could not be confirmed. Try again.');
      return false;
    }
  }
  return (
    <ConfirmDialog
      destructive
      trigger={
        <Button size="small" variant="ghost" aria-label={`Remove ${filename}`}>
          Remove
        </Button>
      }
      title={`Remove ${filename}?`}
      description="This file will be removed from the case."
      confirmLabel="Remove file"
      onConfirm={remove}
    />
  );
}
