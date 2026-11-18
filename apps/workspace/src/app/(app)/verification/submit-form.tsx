'use client';

import { useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/ui/dialog';
import { HeaderAction } from '@/components/ui/header-action';
import { toast } from '@/components/ui/toast';

import { submitCaseAction, type SubmitCaseState } from './case-actions';

export function SubmitForm({
  caseId,
  idempotencyKey,
  missing,
  reloadHref,
}: {
  caseId: string;
  idempotencyKey: string;
  missing: string[];
  reloadHref: string;
}) {
  const [state, setState] = useState<SubmitCaseState>({ key: idempotencyKey });
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const inFlight = useRef(false);

  async function submit() {
    if (inFlight.current || missing.length > 0 || state.reload) return false;
    inFlight.current = true;
    const form = new FormData();
    form.set('caseId', caseId);
    form.set('idempotencyKey', state.key);
    try {
      const result = await submitCaseAction(state, form);
      setState(result);
      if (result.error) return false;
      toast.success('Submitted for review');
      return true;
    } catch {
      setState({ key: state.key, error: 'Submission could not be confirmed. Try again.' });
      return false;
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <>
      <HeaderAction
        ref={opener}
        missing={missing}
        missingTitle="Required before submitting"
        onClick={() => setOpen(true)}
      >
        Submit for review
      </HeaderAction>
      <ConfirmDialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) requestAnimationFrame(() => opener.current?.focus());
        }}
        title="Submit for review?"
        description="The documents will be locked while the case is under review. You can edit them again if the case is rejected."
        confirmLabel="Submit for review"
        onConfirm={submit}
      >
        {missing.length > 0 ? (
          <Alert tone="warning" role="status">
            Required before submitting: {missing.join(', ')}.
          </Alert>
        ) : null}
        {state.error ? (
          <Alert
            tone="error"
            role="alert"
            actions={state.reload ? <a href={reloadHref}>Reload this case</a> : null}
          >
            {state.error}
          </Alert>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
