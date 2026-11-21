'use client';

import type { AdminPaymentTerm } from '@bos/contracts';
import { useState, useTransition, type FormEvent } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input } from '@/components/ui/field';
import { DecimalInput } from '@/components/ui/number-input';
import { toast } from '@/components/ui/toast';

import styles from '../_components/settings.module.css';
import type { ActionState } from '../action-state';
import {
  addPaymentTermAction,
  renamePaymentTermAction,
  setPaymentTermRetiredAction,
} from './payment-term-actions';
import terms from './payment-terms.module.css';

/** "Due on receipt" for 0 days, else "Due in 30 days". */
export function dueText(netDays: number): string {
  if (netDays === 0) return 'Due on receipt';
  return netDays === 1 ? 'Due in 1 day' : `Due in ${netDays} days`;
}

/**
 * The payment terms quotations, customers and suppliers pick from (F1-Q49). Finance, Accountant and the Founder add a
 * term, correct its name, and retire or restore it. The days are fixed once a term exists, because orders and bills
 * read them from the term: a different period is a new term.
 */
export function PaymentTermsPanel({ terms: list }: { terms: readonly AdminPaymentTerm[] }) {
  const [adding, setAdding] = useState(false);
  const [renaming, setRenaming] = useState<AdminPaymentTerm | null>(null);
  const [pending, startTransition] = useTransition();

  const toggleRetired = (term: AdminPaymentTerm) => {
    startTransition(async () => {
      try {
        const state = await setPaymentTermRetiredAction(term.id, !term.retired, term.version);
        if (state.status === 'error') toast.error(state.message);
        else toast.success(state.message);
      } catch {
        toast.error('That change could not be saved. Try again.');
      }
    });
  };

  return (
    <div className={terms.panel}>
      <div className={terms.head}>
        <p className={terms.hint}>
          Offered on quotations and on customer and supplier accounts. A retired term is no longer
          offered; records that already use it keep it.
        </p>
        <Button variant="secondary" size="small" onClick={() => setAdding(true)}>
          Add payment term
        </Button>
      </div>
      {list.length === 0 ? (
        <EmptyState title="No payment terms yet" headingLevel={3}>
          Add the first one.
        </EmptyState>
      ) : (
        <ul className={terms.list} aria-label="Payment terms">
          {list.map((term) => (
            <li key={term.id} className={terms.row} data-retired={term.retired || undefined}>
              <span className={terms.nameLine}>
                <span className={terms.name}>{term.name}</span>
                <span className={terms.meta}>
                  {dueText(term.netDays)} · {term.code}
                </span>
                {term.retired ? <Badge tone="disabled">Retired</Badge> : null}
              </span>
              <span className={terms.actions}>
                <Button
                  variant="ghost"
                  size="small"
                  disabled={pending}
                  onClick={() => setRenaming(term)}
                >
                  Rename<span className="sr-only"> {term.name}</span>
                </Button>
                <Button
                  variant="ghost"
                  size="small"
                  disabled={pending}
                  onClick={() => toggleRetired(term)}
                >
                  {term.retired ? 'Restore' : 'Retire'}
                  <span className="sr-only"> {term.name}</span>
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {adding ? <AddPaymentTermDialog onClose={() => setAdding(false)} /> : null}
      {renaming ? (
        <RenamePaymentTermDialog term={renaming} onClose={() => setRenaming(null)} />
      ) : null}
    </div>
  );
}

function useRun(onDone: () => void) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (action: () => Promise<ActionState>) => {
    startTransition(async () => {
      try {
        const state = await action();
        if (state.status === 'error') {
          setError(state.message);
          return;
        }
        toast.success(state.message);
        onDone();
      } catch {
        setError('That change could not be saved. Try again.');
      }
    });
  };
  return { pending, error, run };
}

function FormError({ message }: { message: string | null }) {
  return (
    <p className={styles.fieldError} role="alert">
      {message ?? ''}
    </p>
  );
}

function AddPaymentTermDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [netDays, setNetDays] = useState('');
  const { pending, error, run } = useRun(onClose);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    run(() => addPaymentTermAction({ code: code.trim(), name, netDays }));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Add payment term"
      description="The days to pay cannot change later. For a different period, add a new term."
      locked={pending}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="submit"
            form="add-payment-term"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? 'Adding…' : 'Add payment term'}
          </Button>
        </>
      }
    >
      <form id="add-payment-term" className={terms.form} noValidate onSubmit={submit}>
        <Field label="Name" hint="As documents show it, for example Net 45.">
          {(c) => (
            <Input {...c} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          )}
        </Field>
        <Field label="Code" hint="1 to 20 capitals, digits, - or _.">
          {(c) => (
            <Input
              {...c}
              value={code}
              maxLength={20}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          )}
        </Field>
        <Field label="Days to pay" hint="0 means due on receipt. Up to 365.">
          {(c) => (
            <DecimalInput
              {...c}
              intDigits={3}
              scale={0}
              min="0"
              max="365"
              value={netDays}
              onValueChange={setNetDays}
            />
          )}
        </Field>
        <FormError message={error} />
      </form>
    </Dialog>
  );
}

function RenamePaymentTermDialog({
  term,
  onClose,
}: {
  term: AdminPaymentTerm;
  onClose: () => void;
}) {
  const [name, setName] = useState(term.name);
  const { pending, error, run } = useRun(onClose);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    if (name.trim() === term.name) {
      onClose();
      return;
    }
    run(() => renamePaymentTermAction(term.id, name, term.version));
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Rename ${term.name}`}
      description={`${dueText(term.netDays)}. The new name shows wherever this term is used, including quotations already sent.`}
      locked={pending}
      closeOnOutsideClick={false}
      footer={
        <>
          <DialogClose asChild>
            <Button variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="submit"
            form="rename-payment-term"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? 'Saving…' : 'Save name'}
          </Button>
        </>
      }
    >
      <form id="rename-payment-term" className={terms.form} noValidate onSubmit={submit}>
        <Field label="Name">
          {(c) => (
            <Input {...c} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          )}
        </Field>
        <FormError message={error} />
      </form>
    </Dialog>
  );
}
