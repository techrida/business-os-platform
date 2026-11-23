'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { ConfirmDialog } from '@/components/ui/dialog';
import { HeaderAction } from '@/components/ui/header-action';
import { toast } from '@/components/ui/toast';

import { submitMemoAction, type SubmitState } from '../actions';
import { UNSAVED_CHANGES_PILL, useMemoReviewNeeded, useMemoSaveStatus } from '../memo-review-gate';

/** How long a Submit waits for a Done save that never reports back before it gives up visibly. */
export const QUEUED_SUBMIT_TIMEOUT_MS = 20_000;

/**
 * The page header's Submit button. The page decides what is still missing (`missing`, short pill labels);
 * `HeaderAction` lists them in a popover when the blocked button is activated (no pills beside the button, UIP-FORM-011). The API's own
 * refusal arrives as a toast, because the action has no field to
 * blame. Confirming submits the form with the memo id.
 *
 * Done then Submit (R2-019): while the edit form's Done is still saving, a confirmed Submit waits. It goes ahead once
 * the saved memo is on the page (so it sends the new version), and is dropped with a message if the save was refused
 * or never finished. It never fails silently.
 */
export function SubmitForm({
  memoId,
  version,
  missing,
}: {
  memoId: string;
  version: number;
  missing: readonly string[];
}) {
  const form = useRef<HTMLFormElement>(null);
  const reviewNeeded = useMemoReviewNeeded();
  const save = useMemoSaveStatus();
  const [queued, setQueued] = useState(false);
  const [state, formAction, pending] = useActionState<SubmitState, FormData>(submitMemoAction, {});

  useEffect(() => {
    if (state.error) toast.error('Not submitted', { description: state.error });
  }, [state]);

  // A waiting Submit settles during render when the save's outcome arrives (no effect-driven state); the effect
  // below then acts once per outcome.
  const [outcome, setOutcome] = useState<{ kind: 'saved' | 'failed' } | null>(null);
  if (queued && (save === 'saved' || save === 'failed')) {
    setQueued(false);
    setOutcome({ kind: save });
  }
  useEffect(() => {
    if (outcome?.kind === 'saved') form.current?.requestSubmit();
    else if (outcome?.kind === 'failed') {
      toast.error('Not submitted', {
        description:
          'Your changes were not saved, so the memo was not submitted. Fix them, press Done, then submit.',
      });
    }
  }, [outcome]);

  useEffect(() => {
    if (!queued) return;
    const timer = setTimeout(() => {
      setQueued(false);
      toast.error('Not submitted', {
        description: 'Saving your changes did not finish. Check the memo, then submit again.',
      });
    }, QUEUED_SUBMIT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [queued]);

  const saving = save === 'saving';
  const busy = pending || queued;
  // While Done is saving, the changes are on their way into the memo: Submit waits for them instead of blocking.
  const blockers = reviewNeeded && !saving ? [UNSAVED_CHANGES_PILL, ...missing] : missing;

  return (
    <>
      <form noValidate ref={form} action={formAction}>
        <input type="hidden" name="memoId" value={memoId} />
        <input type="hidden" name="expectedVersion" value={version} />
      </form>
      <ConfirmDialog
        trigger={
          <HeaderAction
            missing={blockers}
            missingTitle="Cannot submit yet"
            missingLabel="Blocked by"
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? 'Submitting' : 'Submit for approval'}
          </HeaderAction>
        }
        title="Submit for approval?"
        description="The memo will be locked while it is in review."
        confirmLabel="Submit for approval"
        onConfirm={() => {
          if (saving) setQueued(true);
          else form.current?.requestSubmit();
        }}
      />
    </>
  );
}
