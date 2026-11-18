'use client';

import { useActionState, useEffect, useRef } from 'react';

import { ConfirmDialog } from '@/components/ui/dialog';
import { HeaderAction } from '@/components/ui/header-action';
import { toast } from '@/components/ui/toast';

import { submitMemoAction, type SubmitState } from '../actions';
import { useMemoReviewNeeded } from '../memo-review-gate';

/**
 * The page header's Submit button. The page decides what is still missing (`missing`, short pill labels);
 * `HeaderAction` shows them as red pills and explains them when a blocked button is tapped. The API's own
 * refusal (for example "an attachment is not clean yet") arrives as a toast, because the action has no field to
 * blame. Confirming submits the form with the memo id.
 */
export function SubmitForm({ memoId, missing }: { memoId: string; missing: readonly string[] }) {
  const form = useRef<HTMLFormElement>(null);
  const reviewNeeded = useMemoReviewNeeded();
  const [state, formAction, pending] = useActionState<SubmitState, FormData>(submitMemoAction, {});

  useEffect(() => {
    if (state.error) toast.error('Not submitted', { description: state.error });
  }, [state]);

  return (
    <>
      <form ref={form} action={formAction}>
        <input type="hidden" name="memoId" value={memoId} />
      </form>
      <ConfirmDialog
        trigger={
          <HeaderAction
            missing={reviewNeeded ? ['Review changes', ...missing] : missing}
            missingTitle="Cannot submit yet"
            missingLabel="Blocked by"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? 'Submitting' : 'Submit for approval'}
          </HeaderAction>
        }
        title="Submit for approval?"
        description="The memo and its attachments will be locked while it is in review."
        confirmLabel="Submit for approval"
        onConfirm={() => form.current?.requestSubmit()}
      />
    </>
  );
}
