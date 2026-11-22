'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { DateTimePicker } from '@/components/ui/date-time-picker';
import { Field, Select } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';

import { ProcurementFormActions } from '../../form-actions';
import styles from '../../requests/requests.module.css';
import type { RfqFormState } from '../_lib/state';
import rows from './line-rows.module.css';

const WIDE = styles.wide ?? '';

export interface RequestOption {
  id: string;
  label: string;
}
export interface VendorOption {
  id: string;
  name: string;
}

/**
 * Opens an RFQ on a department-approved purchase request. Inputs are controlled so a refusal does
 * not wipe what was chosen (React 19 resets uncontrolled fields after every action). The deadline
 * is typed in Kathmandu time; the server action adds the +05:45 offset.
 */
export function RfqForm({
  action,
  idempotencyKey,
  requests,
  vendors,
  initialRequestId,
  cancelHref,
  reloadHref,
}: {
  action: (prev: RfqFormState, form: FormData) => Promise<RfqFormState>;
  /** A UUID the server made for this render. */
  idempotencyKey: string;
  requests: RequestOption[];
  vendors: VendorOption[];
  initialRequestId: string;
  cancelHref: string;
  reloadHref: string;
}) {
  const [state, formAction, pending] = useActionState<RfqFormState, FormData>(action, {
    key: idempotencyKey,
    errors: {},
  });
  const [requestId, setRequestId] = useState(initialRequestId);
  const [deadline, setDeadline] = useState('');
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.error) summaryRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const err = state.errors;
  const toggle = (id: string, on: boolean): void =>
    setChosen((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <form ref={formRef} action={formAction} noValidate className={styles.form}>
      <PageHeader
        title="New RFQ"
        description="Ask approved vendors to quote on a department-approved purchase request."
        actions={
          <ProcurementFormActions
            cancelHref={cancelHref}
            submitLabel={pending ? 'Opening' : 'Open RFQ'}
            disabled={pending}
          />
        }
      />
      {pending ? (
        <span className="sr-only" role="status">
          Opening the RFQ
        </span>
      ) : null}
      <input type="hidden" name="idempotencyKey" value={state.key} />

      {state.error ? (
        <Alert
          ref={summaryRef}
          tabIndex={-1}
          tone="error"
          role="alert"
          title={state.reload ? 'This page is out of date' : 'The RFQ was not opened'}
          actions={state.reload ? <a href={reloadHref}>Reload this page</a> : null}
        >
          {state.error}
        </Alert>
      ) : null}

      <Panel
        title="Request details"
        description="Vendors are asked to quote on the lines of the purchase request."
      >
        <div className={styles.grid}>
          <Field label="Purchase request" error={err.purchaseRequestId} className={WIDE}>
            {(control) => (
              <Select
                name="purchaseRequestId"
                value={requestId}
                onChange={(e) => setRequestId(e.target.value)}
                required
                {...control}
              >
                <option value="">Choose a purchase request</option>
                {requests.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Quotation deadline"
            hint="Kathmandu time. Quotations sent after it are refused; you can extend it while the RFQ is open."
            error={err.deadline}
          >
            {(control) => (
              <DateTimePicker
                {...control}
                name="deadline"
                value={deadline}
                onChange={setDeadline}
                required
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel
        title="Vendors to invite"
        description="Only approved vendors with an account in this entity can be invited. Invite enough to meet the minimum number of quotations your company requires."
      >
        <fieldset
          className={rows.group}
          aria-describedby={err.vendorIds ? 'vendors-error' : undefined}
        >
          <legend>Invited vendors ({chosen.size} chosen)</legend>
          {vendors.map((v) => (
            <label key={v.id} className={styles.check}>
              <input
                type="checkbox"
                name="vendorIds"
                value={v.id}
                checked={chosen.has(v.id)}
                onChange={(e) => toggle(v.id, e.target.checked)}
              />
              <span className={styles.long}>{v.name}</span>
            </label>
          ))}
        </fieldset>
        {err.vendorIds ? (
          <p id="vendors-error" role="alert" className={styles.status}>
            {err.vendorIds}
          </p>
        ) : null}
      </Panel>
    </form>
  );
}
