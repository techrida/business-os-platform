'use client';

import type { AdminTaxCode, TaxCodeKind } from '@bos/contracts';
import { useState, useTransition, type FormEvent } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { ConfirmDialog, Dialog, DialogClose } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Input, Select } from '@/components/ui/field';
import { PercentInput } from '@/components/ui/number-input';
import { Table, Td, Th } from '@/components/ui/table';
import { toast } from '@/components/ui/toast';

import styles from '../_components/settings.module.css';
import type { ActionState } from '../action-state';
import admin from '../admin.module.css';
import { withoutTrailingZeros } from '../format';
import { addTaxCodeAction, changeTaxCodeAction, retireTaxCodeAction } from './actions';
import {
  firstEditableDay,
  isClosed,
  isZeroRateKind,
  KIND_LABEL,
  KIND_OPTIONS,
  shownRate,
  statusText,
} from './tax-code-model';
import tax from './tax.module.css';
import { Checkbox } from '@/components/ui/checkbox';

/** Tax-code rates take two decimals here, though the column stores four ("13.0000"). */
const RATE_SCALE = 2;

/**
 * The VAT codes table on Settings > Tax (F1-Q49): every code with the rate in force today. Finance, Accountant and
 * the Founder add a code, change one from a day no earlier than today, or retire one. Nothing is edited in place:
 * a change starts a new rate on its day and a retired code stops being offered, so documents already issued keep
 * the rate they were priced with.
 */
export function TaxCodesManager({
  codes,
  today,
}: {
  codes: readonly AdminTaxCode[];
  today: string;
}) {
  const [adding, setAdding] = useState(false);
  const [changing, setChanging] = useState<AdminTaxCode | null>(null);
  const [retiring, setRetiring] = useState<AdminTaxCode | null>(null);

  return (
    <div className={tax.manager}>
      <div className={tax.head}>
        <p className={tax.hint}>
          A rate change starts on the day you choose, today or later. Documents already issued keep
          the rate they were priced with.
        </p>
        <Button variant="secondary" size="small" onClick={() => setAdding(true)}>
          Add tax code
        </Button>
      </div>

      {codes.length === 0 ? (
        <EmptyState title="No VAT codes yet" headingLevel={3}>
          Add the first one.
        </EmptyState>
      ) : (
        <Table caption="VAT codes" className={admin.local ?? ''}>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Code</Th>
              <Th>Kind</Th>
              <Th align="end">Rate</Th>
              <Th>Status</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </thead>
          <tbody>
            {codes.map((code) => {
              const shown = code.current ?? code.next ?? code.latest;
              const closed = isClosed(code);
              return (
                <tr key={code.code}>
                  <Th scope="row" className={admin.rowHead}>
                    {shown.name}
                  </Th>
                  <Td>{code.code}</Td>
                  <Td>{KIND_LABEL[code.kind]}</Td>
                  <Td align="end">{shownRate(code)}</Td>
                  <Td>
                    {closed && code.endsOn !== null && code.endsOn <= today ? (
                      <Badge tone="disabled">{statusText(code, today)}</Badge>
                    ) : (
                      statusText(code, today)
                    )}
                  </Td>
                  <Td nowrap>
                    {closed ? null : (
                      <span className={tax.rowActions}>
                        <Button variant="ghost" size="small" onClick={() => setChanging(code)}>
                          Change<span className="sr-only"> {code.code}</span>
                        </Button>
                        <Button variant="ghost" size="small" onClick={() => setRetiring(code)}>
                          Retire<span className="sr-only"> {code.code}</span>
                        </Button>
                      </span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      {adding ? <AddTaxCodeDialog today={today} onClose={() => setAdding(false)} /> : null}
      {changing ? (
        <ChangeTaxCodeDialog code={changing} today={today} onClose={() => setChanging(null)} />
      ) : null}
      {retiring ? (
        <RetireTaxCodeDialog code={retiring} today={today} onClose={() => setRetiring(null)} />
      ) : null}
    </div>
  );
}

/** Runs one action: a toast says what happened, and the dialog closes only when it worked. */
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
  return { pending, error, setError, run };
}

function FormError({ message }: { message: string | null }) {
  return (
    <p className={styles.fieldError} role="alert">
      {message ?? ''}
    </p>
  );
}

function AddTaxCodeDialog({ today, onClose }: { today: string; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TaxCodeKind>('vat');
  const [rate, setRate] = useState('');
  const [creditable, setCreditable] = useState(true);
  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const { pending, error, run } = useRun(onClose);
  const zero = isZeroRateKind(kind);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    run(() =>
      addTaxCodeAction({
        code: code.trim(),
        name,
        kind,
        rate: zero ? '0' : rate,
        creditable,
        effectiveFrom,
      }),
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Add tax code"
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
            form="add-tax-code"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? 'Adding…' : 'Add tax code'}
          </Button>
        </>
      }
    >
      <form id="add-tax-code" className={tax.form} noValidate onSubmit={submit}>
        <Field label="Name">
          {(c) => (
            <Input
              {...c}
              value={name}
              maxLength={80}
              placeholder="VAT 13%"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field label="Code">
          {(c) => (
            <Input
              {...c}
              value={code}
              maxLength={20}
              placeholder="VAT-13"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          )}
        </Field>
        <Field label="Kind">
          {(c) => (
            <Select
              {...c}
              name="kind"
              value={kind}
              onChange={(e) => setKind(e.currentTarget.value as TaxCodeKind)}
            >
              {KIND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Rate" hint={zero ? 'Exempt and zero-rated codes are always 0%.' : undefined}>
          {(c) => (
            <PercentInput
              {...c}
              scale={RATE_SCALE}
              placeholder="13"
              value={zero ? '0' : rate}
              disabled={zero}
              onValueChange={setRate}
            />
          )}
        </Field>
        <label className={styles.checkLabel}>
          <Checkbox
            checked={creditable}
            onCheckedChange={(nextChecked) => setCreditable(nextChecked)}
          />
          Input tax can be claimed back
        </label>
        <Field label="In use from">
          {(c) => (
            <DatePicker
              {...c}
              value={effectiveFrom}
              min={today}
              onChange={setEffectiveFrom}
              required
            />
          )}
        </Field>
        <FormError message={error} />
      </form>
    </Dialog>
  );
}

function ChangeTaxCodeDialog({
  code,
  today,
  onClose,
}: {
  code: AdminTaxCode;
  today: string;
  onClose: () => void;
}) {
  const first = firstEditableDay(code, today);
  const [name, setName] = useState(code.latest.name);
  const [rate, setRate] = useState(() => withoutTrailingZeros(code.latest.rate, RATE_SCALE));
  const [creditable, setCreditable] = useState(code.latest.creditable);
  const [effectiveFrom, setEffectiveFrom] = useState(first);
  const { pending, error, run } = useRun(onClose);
  const zero = isZeroRateKind(code.kind);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    run(() =>
      changeTaxCodeAction(code.code, {
        name,
        rate: zero ? '0' : rate,
        creditable,
        effectiveFrom,
        expectedPeriodId: code.latest.id,
        expectedVersion: code.latest.version,
      }),
    );
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Change ${code.code}`}
      description="The current rate applies up to the day before. Documents already issued keep the rate they were priced with."
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
            form="change-tax-code"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            {pending ? 'Saving…' : 'Save change'}
          </Button>
        </>
      }
    >
      <form id="change-tax-code" className={tax.form} noValidate onSubmit={submit}>
        <Field label="Name">
          {(c) => (
            <Input {...c} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
          )}
        </Field>
        <Field
          label="Rate"
          hint={zero ? `${KIND_LABEL[code.kind]} codes are always 0%.` : undefined}
        >
          {(c) => (
            <PercentInput
              {...c}
              scale={RATE_SCALE}
              placeholder="13"
              value={zero ? '0' : rate}
              disabled={zero}
              onValueChange={setRate}
            />
          )}
        </Field>
        <label className={styles.checkLabel}>
          <Checkbox
            checked={creditable}
            onCheckedChange={(nextChecked) => setCreditable(nextChecked)}
          />
          Input tax can be claimed back
        </label>
        <Field label="New rate applies from">
          {(c) => (
            <DatePicker
              {...c}
              value={effectiveFrom}
              min={first}
              onChange={setEffectiveFrom}
              required
            />
          )}
        </Field>
        <FormError message={error} />
      </form>
    </Dialog>
  );
}

function RetireTaxCodeDialog({
  code,
  today,
  onClose,
}: {
  code: AdminTaxCode;
  today: string;
  onClose: () => void;
}) {
  const first = firstEditableDay(code, today);
  const [effectiveTo, setEffectiveTo] = useState(first);
  const [error, setError] = useState<string | null>(null);

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Retire ${code.code}?`}
      description="From the day you choose it is no longer offered on new documents. Documents that already use it keep it."
      confirmLabel="Retire tax code"
      destructive
      onConfirm={async () => {
        const state = await retireTaxCodeAction(code.code, effectiveTo, {
          expectedPeriodId: code.latest.id,
          expectedVersion: code.latest.version,
        });
        if (state.status === 'error') {
          setError(state.message);
          return false;
        }
        toast.success(state.message);
        onClose();
        return true;
      }}
    >
      <Field label="Not offered from">
        {(c) => (
          <DatePicker {...c} value={effectiveTo} min={first} onChange={setEffectiveTo} required />
        )}
      </Field>
      <FormError message={error} />
    </ConfirmDialog>
  );
}
