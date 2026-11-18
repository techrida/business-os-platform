'use client';

import type { ReceiptKind } from '@bos/contracts';
import { useActionState, useRef, useState } from 'react';

import { useFocusOnProblem } from '@/components/p2/quotations/action-dialog';
import { Alert } from '@/components/ui/alert';
import { Field, Input, Textarea } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';

import { ProcurementFormActions } from '../../form-actions';

import type { ActionState } from '../../orders/_lib/state';
import { createReceiptAction } from '../actions';
import styles from '../receipts.module.css';

/**
 * The new-receipt form. The page works out, on the server, what each line has room for (open minus
 * what drafts reserve) and hands it over as text; nothing here adds or compares quantities. The
 * checks that count run in the action, which reads the order's progress again. Inputs are
 * controlled so a refusal does not wipe what was typed (React 19 resets uncontrolled fields after
 * every action). The page makes one Idempotency-Key per render; the action hands back the key the
 * next submit must use (kept after a timeout, rotated after a 4xx).
 */

export interface FormLine {
  poLineId: string;
  lineNo: number;
  kind: ReceiptKind;
  description: string;
  uom: string;
  requiresSerials: boolean;
  /** Everything below is display text from the server, e.g. `10`, `4`, `1`, `5`. */
  ordered: string;
  received: string;
  pending: string;
  cap: string;
  hasRoom: boolean;
}

interface LineValues {
  quantity: string;
  serials: string;
  inspection: string;
  note: string;
}

const KIND_TEXT: Record<ReceiptKind, string> = {
  goods: 'Goods (items delivered to the warehouse)',
  service: 'A service (work done or a visit made)',
};

const blank = (): LineValues => ({ quantity: '', serials: '', inspection: '', note: '' });

/** Display only: how many serial numbers are typed, one per line. */
const serialCount = (text: string): number =>
  text.split(/\r?\n/).filter((s) => s.trim() !== '').length;

export function ReceiptForm({
  purchaseOrderId,
  number,
  idempotencyKey,
  today,
  kinds,
  lines,
  cancelHref,
  reloadHref,
}: {
  purchaseOrderId: string;
  number: string;
  idempotencyKey: string;
  /** Today in Kathmandu as `YYYY-MM-DD`, worked out on the server. */
  today: string;
  /** The kinds this person can start now; never empty. */
  kinds: readonly [ReceiptKind, ...ReceiptKind[]];
  lines: readonly FormLine[];
  cancelHref: string;
  reloadHref: string;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(createReceiptAction, {
    key: idempotencyKey,
  });
  const [kind, setKind] = useState<ReceiptKind>(kinds[0]);
  const [receivedAt, setReceivedAt] = useState(today);
  const [location, setLocation] = useState('');
  const [values, setValues] = useState<Record<string, LineValues>>({});
  const wrapRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrapRef, summaryRef);

  const errors = state.errors ?? {};
  const valueOf = (id: string): LineValues => values[id] ?? blank();
  const set = (id: string, field: keyof LineValues, value: string): void =>
    setValues((v) => ({ ...v, [id]: { ...blank(), ...v[id], [field]: value } }));
  const shown = lines.filter((l) => l.kind === kind);

  return (
    <div ref={wrapRef}>
      <form action={formAction} noValidate className={styles.form}>
        <PageHeader
          title="New receipt"
          description={`Record what arrived on ${number}. Only what is still open can be received.`}
          actions={
            <ProcurementFormActions
              cancelHref={cancelHref}
              submitLabel="Save draft receipt"
              disabled={pending}
            />
          }
        />
        {pending ? (
          <span className="sr-only" role="status">
            Saving the draft receipt
          </span>
        ) : null}
        <input type="hidden" name="purchaseOrderId" value={purchaseOrderId} />
        <input type="hidden" name="idempotencyKey" value={state.key} />

        {state.error ? (
          <Alert
            ref={summaryRef}
            tabIndex={-1}
            tone="error"
            role="alert"
            actions={state.reload ? <a href={reloadHref}>Reload this page</a> : null}
          >
            {state.error}
          </Alert>
        ) : null}
        {errors['lines'] ? (
          <p role="alert" className={styles.fieldError}>
            {errors['lines']}
          </p>
        ) : null}

        <Panel title="Receipt details">
          {kinds.length > 1 ? (
            <fieldset className={styles.kindGroup}>
              <legend>What is being received</legend>
              {kinds.map((k) => (
                <label key={k} className={styles.choice}>
                  <input
                    type="radio"
                    name="kind"
                    value={k}
                    checked={kind === k}
                    onChange={() => setKind(k)}
                  />
                  {KIND_TEXT[k]}
                </label>
              ))}
              {errors['kind'] ? <span className={styles.fieldError}>{errors['kind']}</span> : null}
            </fieldset>
          ) : (
            <>
              <input type="hidden" name="kind" value={kind} />
              <p className={styles.note}>
                Receiving {kind === 'goods' ? 'goods' : 'a service'} on {number}. One receipt takes
                one kind.
              </p>
            </>
          )}

          <div className={styles.formRow}>
            <Field
              label="Received on"
              hint="The day it arrived. Today, in Kathmandu, unless you change it."
              error={errors['receivedAt']}
            >
              {(c) => (
                <Input
                  type="date"
                  name="receivedAt"
                  value={receivedAt}
                  onChange={(e) => setReceivedAt(e.target.value)}
                  required
                  {...c}
                />
              )}
            </Field>
            <Field label="Location" hint="Optional. Where it was put." error={errors['location']}>
              {(c) => (
                <Input
                  name="location"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  maxLength={200}
                  autoComplete="off"
                  {...c}
                />
              )}
            </Field>
          </div>
        </Panel>

        <Panel title="Line items">
          {shown.map((l) => {
            const v = valueOf(l.poLineId);
            const count = serialCount(v.serials);
            const units = /^\d{1,4}$/.test(v.quantity.trim()) ? Number(v.quantity) : null;
            return (
              <fieldset key={l.poLineId} className={styles.lineGroup}>
                <legend>
                  Line {l.lineNo}: {l.description}
                </legend>
                <p className={styles.note}>
                  Ordered {l.ordered} {l.uom}. Received {l.received}
                  {l.pending !== '0' ? `, ${l.pending} waiting in draft receipts` : ''}.{' '}
                  {l.hasRoom
                    ? `Up to ${l.cap} ${l.uom} can be received now.`
                    : 'Nothing is left to receive on this line.'}
                  {l.requiresSerials ? ' Each unit has a serial number.' : ''}
                </p>
                {l.hasRoom ? (
                  <>
                    <div className={styles.lineFields}>
                      <Field
                        label={`Quantity received (${l.uom})`}
                        hint="Leave empty to skip this line."
                        error={errors[`${l.poLineId}.quantity`]}
                      >
                        {(c) => (
                          <Input
                            name={`qty:${l.poLineId}`}
                            value={v.quantity}
                            onChange={(e) => set(l.poLineId, 'quantity', e.target.value)}
                            inputMode="decimal"
                            autoComplete="off"
                            className={styles.numeric}
                            {...c}
                          />
                        )}
                      </Field>
                    </div>
                    {l.requiresSerials ? (
                      <Field
                        label="Serial numbers"
                        hint="One per line, as many as units received. Each must be different."
                        error={errors[`${l.poLineId}.serials`]}
                      >
                        {(c) => (
                          <>
                            <Textarea
                              name={`serials:${l.poLineId}`}
                              value={v.serials}
                              onChange={(e) => set(l.poLineId, 'serials', e.target.value)}
                              rows={4}
                              autoComplete="off"
                              spellCheck={false}
                              {...c}
                            />
                            <p className={styles.note} aria-live="polite">
                              {units !== null
                                ? `${count} of ${units} serial numbers entered`
                                : `${count} serial numbers entered`}
                            </p>
                          </>
                        )}
                      </Field>
                    ) : null}
                    <div className={styles.lineFields}>
                      <Field
                        label="Inspection"
                        hint="Optional. What was checked."
                        error={errors[`${l.poLineId}.inspection`]}
                      >
                        {(c) => (
                          <Input
                            name={`inspection:${l.poLineId}`}
                            value={v.inspection}
                            onChange={(e) => set(l.poLineId, 'inspection', e.target.value)}
                            maxLength={500}
                            autoComplete="off"
                            {...c}
                          />
                        )}
                      </Field>
                      <Field
                        label="Discrepancy note"
                        hint="Optional. Damage, shortage or a wrong item."
                        error={errors[`${l.poLineId}.note`]}
                      >
                        {(c) => (
                          <Input
                            name={`note:${l.poLineId}`}
                            value={v.note}
                            onChange={(e) => set(l.poLineId, 'note', e.target.value)}
                            maxLength={1000}
                            autoComplete="off"
                            {...c}
                          />
                        )}
                      </Field>
                    </div>
                  </>
                ) : null}
              </fieldset>
            );
          })}

          <p className={styles.note}>
            The receipt is saved as a draft. Nothing counts as received on {number} until it is
            confirmed.
          </p>
        </Panel>
      </form>
    </div>
  );
}
