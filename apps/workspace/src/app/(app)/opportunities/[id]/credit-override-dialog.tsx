'use client';

import { useEffect, useId, useRef, useState, useTransition, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';
import type { CreditPositionView } from '@/components/p2/crm/credit-position';

import { overrideCreditHoldAction, type CreditOverrideState } from '../actions';
import styles from './detail.module.css';

const REASON_MAX = 500;
const REASON_REQUIRED = 'Say why this deal may go ahead, up to 500 characters.';

/**
 * Override credit hold (F1-Q20), for holders of `credit.override`: a required reason in a dialog
 * with its actions in the fixed footer (UIP-DLG-001). Success closes with a toast; a refusal keeps
 * the reason and moves focus to it, so a screen reader reads the error with the field. `position` shows what the
 * hold is made of (limit, receivables, orders not yet invoiced, this order), so the person overrides knowingly.
 */
export function CreditOverrideDialog({
  opportunityId,
  number,
  quotation,
  position,
  successMessage,
  onOverridden,
}: {
  opportunityId: string;
  /** The deal's number, named in the dialog so the person knows which deal goes ahead; null when unknown. */
  number: string | null;
  /**
   * The quotation being confirmed, when the override is offered from a refused confirm: it names the deal
   * for someone who cannot read the deal's number, and ties the override to the quotation in front of them.
   */
  quotation?: string | undefined;
  /** The customer's position against the limit, when it could be read. */
  position?: CreditPositionView | undefined;
  /** The toast after a save. Default: names the deal and says it can go to a sales order. */
  successMessage?: string | undefined;
  /** Called after the override is saved. */
  onOverridden?: (() => void) | undefined;
}) {
  const deal = number ?? 'The opportunity';
  const subject =
    quotation === undefined
      ? deal
      : `The deal of quotation ${quotation}${number === null ? '' : ` (${number})`}`;
  const formId = useId();
  const [open, setOpenState] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [pending, startTransition] = useTransition();
  const [round, setRound] = useState(0);
  const [refusals, setRefusals] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (refusals > 0) formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [refusals]);

  function setOpen(next: boolean) {
    if (next) {
      setError(undefined);
      setRound((r) => r + 1);
    }
    setOpenState(next);
  }

  function refuse(message: string) {
    setError(message);
    setRefusals((n) => n + 1);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const value = data.get('reason');
    const reason = typeof value === 'string' ? value.trim() : '';
    if (!reason || reason.length > REASON_MAX) {
      refuse(REASON_REQUIRED);
      return;
    }
    data.set('reason', reason);
    startTransition(async () => {
      const result: CreditOverrideState = await overrideCreditHoldAction({}, data);
      if (result.ok) {
        setOpenState(false);
        toast.success(successMessage ?? `Credit hold overridden. ${deal} can go to a sales order.`);
        onOverridden?.();
        return;
      }
      const fieldError = result.fieldErrors?.reason;
      if (fieldError) {
        refuse(fieldError);
        return;
      }
      toast.error(
        result.error ?? 'The credit hold could not be overridden.',
        result.reload
          ? { action: { label: 'Reload', onClick: () => window.location.reload() } }
          : undefined,
      );
    });
  }

  return (
    <Dialog
      trigger={<Button variant="secondary">Override credit hold</Button>}
      open={open}
      onOpenChange={setOpen}
      title="Override the credit hold?"
      description={`${subject} can then be confirmed as a sales order although, with its receivables, its orders not yet invoiced and this order, the customer is over its credit limit. The override covers an order of this value; a bigger one needs a new override.`}
      locked={pending}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" form={formId} disabled={pending} aria-busy={pending || undefined}>
            {pending ? 'Saving' : 'Override hold'}
          </Button>
        </>
      }
    >
      <form
        ref={formRef}
        key={round}
        id={formId}
        noValidate
        onSubmit={onSubmit}
        className={styles.overrideForm}
      >
        <input type="hidden" name="opportunityId" value={opportunityId} />
        {position ? <input type="hidden" name="orderValue" value={position.orderValue} /> : null}
        {position ? (
          <div>
            <dl className={styles.overridePosition}>
              {position.rows.map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>{row.value}</dd>
                </div>
              ))}
            </dl>
            {position.note ? <p>{position.note}</p> : null}
          </div>
        ) : null}
        <Field
          label="Reason"
          hint="Recorded with your name on the deal and in the audit log."
          error={error}
        >
          {(control) => (
            <Textarea
              name="reason"
              rows={4}
              maxLength={REASON_MAX}
              required
              onChange={() => setError(undefined)}
              {...control}
            />
          )}
        </Field>
      </form>
    </Dialog>
  );
}
