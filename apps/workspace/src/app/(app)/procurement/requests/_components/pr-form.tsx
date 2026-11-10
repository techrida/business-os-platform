'use client';

import { CURRENCIES, PR_REQUEST_TYPES } from '@bos/contracts';
import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Panel } from '@/components/ui/panel';

import { emptyLine, type LineValues, type PrValues } from '../_lib/forms';
import { REQUEST_TYPE_LABEL } from '../_lib/model';
import type { PrFormState } from '../_lib/state';
import styles from '../requests.module.css';

const WIDE = styles.wide ?? '';
const MAX_LINES = 200;

// Cost centres have no backing table or lookup yet. Keep manual reference entry in both modes.

interface Row {
  /** Stable across add and remove, so a typed value never jumps to another line. */
  uid: number;
  line: LineValues;
}

/**
 * The purchase request create and edit form. One component for both: the server action passed in
 * decides what happens on submit. Inputs are controlled so a refusal does not wipe what was typed
 * (React 19 resets uncontrolled fields after every action).
 *
 * There is no running total on purpose. Quantities and prices go to the platform as typed, and the
 * totals (and the NPR estimate) are what the platform sends back on the request page.
 */
export function PrForm({
  action,
  departments,
  initial,
  mode,
  idempotencyKey,
  prId,
  version,
  cancelHref,
  reloadHref,
}: {
  action: (prev: PrFormState, form: FormData) => Promise<PrFormState>;
  departments: { id: string; name: string }[];
  initial: PrValues;
  mode: 'create' | 'edit';
  /** A UUID the server made for this render. */
  idempotencyKey: string;
  /** The request being edited, and the version the person is looking at. */
  prId?: string;
  version?: number;
  cancelHref: string;
  reloadHref: string;
}) {
  const [state, formAction, pending] = useActionState<PrFormState, FormData>(action, {
    key: idempotencyKey,
    errors: {},
  });
  const [values, setValues] = useState<PrValues>(initial);
  const nextUid = useRef(initial.lines.length);
  const [rows, setRows] = useState<Row[]>(() => initial.lines.map((line, uid) => ({ uid, line })));
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  type HeaderKey = Exclude<keyof PrValues, 'lines' | 'isEmergency'>;
  const set =
    (field: HeaderKey) =>
    (e: { target: { value: string } }): void =>
      setValues((v) => ({ ...v, [field]: e.target.value }));
  const setLine =
    (uid: number, field: Exclude<keyof LineValues, 'requiresSerials'>) =>
    (e: { target: { value: string } }): void =>
      setRows((rs) =>
        rs.map((r) => (r.uid === uid ? { ...r, line: { ...r.line, [field]: e.target.value } } : r)),
      );
  const addLine = (): void => {
    setRows((rs) =>
      rs.length >= MAX_LINES ? rs : [...rs, { uid: nextUid.current++, line: emptyLine() }],
    );
  };
  const removeLine = (uid: number): void =>
    setRows((rs) => (rs.length <= 1 ? rs : rs.filter((r) => r.uid !== uid)));

  // Send focus to what needs attention: the summary, else the first field that is wrong.
  useEffect(() => {
    if (state.error) summaryRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const err = state.errors;
  const submitLabel = pending ? 'Saving' : mode === 'edit' ? 'Save changes' : 'Save draft';

  return (
    <form ref={formRef} action={formAction} noValidate className={styles.form}>
      <input type="hidden" name="idempotencyKey" value={state.key} />
      {mode === 'edit' ? (
        <>
          <input type="hidden" name="prId" value={prId} />
          <input type="hidden" name="expectedVersion" value={version} />
        </>
      ) : null}

      {state.error ? (
        <Alert
          ref={summaryRef}
          tabIndex={-1}
          tone="error"
          role="alert"
          title={state.reload ? 'This page is out of date' : 'Nothing was saved'}
          actions={state.reload ? <a href={reloadHref}>Reload this request</a> : null}
        >
          {state.error}
        </Alert>
      ) : null}

      <Panel title="Request">
        <div className={styles.grid}>
          <Field label="Type" error={err.requestType}>
            {(control) => (
              <Select
                name="requestType"
                value={values.requestType}
                onChange={set('requestType')}
                {...control}
              >
                {PR_REQUEST_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {REQUEST_TYPE_LABEL[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Needed by" error={err.requiredBy}>
            {(control) => (
              <Input
                type="date"
                name="requiredBy"
                value={values.requiredBy}
                onChange={set('requiredBy')}
                required
                {...control}
              />
            )}
          </Field>
          <Field label="Department" error={err.departmentId}>
            {(control) => (
              <Select
                name="departmentId"
                value={values.departmentId}
                onChange={set('departmentId')}
                required
                {...control}
              >
                <option value="">Select a department</option>
                {values.departmentId && !departments.some((d) => d.id === values.departmentId) ? (
                  <option value={values.departmentId}>Department name unavailable</option>
                ) : null}
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Cost centre" hint="The cost centre's id." error={err.costCenterId}>
            {(control) => (
              <Input
                name="costCenterId"
                value={values.costCenterId}
                onChange={set('costCenterId')}
                autoComplete="off"
                spellCheck={false}
                required
                {...control}
              />
            )}
          </Field>
          <Field label="Budget code" error={err.budgetCode}>
            {(control) => (
              <Input
                name="budgetCode"
                value={values.budgetCode}
                onChange={set('budgetCode')}
                maxLength={64}
                autoComplete="off"
                required
                {...control}
              />
            )}
          </Field>
          <Field
            label="Currency"
            hint="The estimates below are in this currency."
            error={err.currency}
          >
            {(control) => (
              <Select
                name="currency"
                value={values.currency}
                onChange={set('currency')}
                {...control}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Delivery location" hint="Optional." error={err.deliveryLocation}>
            {(control) => (
              <Input
                name="deliveryLocation"
                value={values.deliveryLocation}
                onChange={set('deliveryLocation')}
                maxLength={200}
                {...control}
              />
            )}
          </Field>
          <Field
            label="Project"
            hint="Optional. Enter the project reference, or leave blank."
            error={err.projectId}
          >
            {(control) => (
              <Input
                name="projectId"
                value={values.projectId}
                onChange={set('projectId')}
                autoComplete="off"
                spellCheck={false}
                {...control}
              />
            )}
          </Field>
          <Field
            label="Why is this needed?"
            hint="The department head reads this when deciding."
            error={err.justification}
            className={WIDE}
          >
            {(control) => (
              <Textarea
                name="justification"
                value={values.justification}
                onChange={set('justification')}
                rows={3}
                maxLength={2000}
                required
                {...control}
              />
            )}
          </Field>
          <div className={WIDE}>
            <label className={styles.check}>
              <input
                type="checkbox"
                name="isEmergency"
                checked={values.isEmergency}
                onChange={(e) => setValues((v) => ({ ...v, isEmergency: e.target.checked }))}
              />
              This is an emergency purchase
            </label>
          </div>
          {values.isEmergency ? (
            <Field
              label="Why is it an emergency?"
              hint="An emergency request also needs Management's approval."
              error={err.emergencyReason}
              className={WIDE}
            >
              {(control) => (
                <Textarea
                  name="emergencyReason"
                  value={values.emergencyReason}
                  onChange={set('emergencyReason')}
                  rows={2}
                  maxLength={1000}
                  required
                  {...control}
                />
              )}
            </Field>
          ) : null}
        </div>
      </Panel>

      <Panel
        title="Lines"
        description="What is needed, with your estimate of the unit price. The platform works out the totals when you save."
      >
        <div className={styles.lines}>
          {rows.map((row, i) => (
            <fieldset key={row.uid} className={styles.line}>
              <legend>Line {i + 1}</legend>
              <div className={styles.lineGrid}>
                <Field label="Description" error={err[`lines.${i}.description`]} className={WIDE}>
                  {(control) => (
                    <Input
                      name={`lines.${i}.description`}
                      value={row.line.description}
                      onChange={setLine(row.uid, 'description')}
                      maxLength={500}
                      required
                      {...control}
                    />
                  )}
                </Field>
                <Field
                  label="Specification"
                  hint="Optional."
                  error={err[`lines.${i}.specification`]}
                  className={WIDE}
                >
                  {(control) => (
                    <Textarea
                      name={`lines.${i}.specification`}
                      value={row.line.specification}
                      onChange={setLine(row.uid, 'specification')}
                      rows={2}
                      maxLength={2000}
                      {...control}
                    />
                  )}
                </Field>
                {values.requestType === 'goods' ? (
                  <label>
                    <input
                      type="checkbox"
                      name={`lines.${i}.requiresSerials`}
                      checked={row.line.requiresSerials ?? false}
                      onChange={(e) => {
                        const checked = e.target.checked;
                        setRows((rs) =>
                          rs.map((r) =>
                            r.uid === row.uid
                              ? { ...r, line: { ...r.line, requiresSerials: checked } }
                              : r,
                          ),
                        );
                      }}
                    />{' '}
                    Record serial numbers at receipt
                  </label>
                ) : null}
                <Field label="Unit" error={err[`lines.${i}.uom`]}>
                  {(control) => (
                    <Input
                      name={`lines.${i}.uom`}
                      value={row.line.uom}
                      onChange={setLine(row.uid, 'uom')}
                      maxLength={20}
                      required
                      {...control}
                    />
                  )}
                </Field>
                <Field label="Quantity" error={err[`lines.${i}.quantity`]}>
                  {(control) => (
                    <Input
                      name={`lines.${i}.quantity`}
                      value={row.line.quantity}
                      onChange={setLine(row.uid, 'quantity')}
                      inputMode="decimal"
                      autoComplete="off"
                      className={styles.numeric}
                      required
                      {...control}
                    />
                  )}
                </Field>
                <Field
                  label={`Estimated unit price (${values.currency})`}
                  error={err[`lines.${i}.estimatedUnitPrice`]}
                >
                  {(control) => (
                    <Input
                      name={`lines.${i}.estimatedUnitPrice`}
                      value={row.line.estimatedUnitPrice}
                      onChange={setLine(row.uid, 'estimatedUnitPrice')}
                      inputMode="decimal"
                      autoComplete="off"
                      className={styles.numeric}
                      required
                      {...control}
                    />
                  )}
                </Field>
              </div>
              <div className={styles.lineHead}>
                <span />
                <Button
                  variant="ghost"
                  size="small"
                  onClick={() => removeLine(row.uid)}
                  disabled={rows.length <= 1}
                  aria-label={`Remove line ${i + 1}`}
                >
                  Remove line
                </Button>
              </div>
            </fieldset>
          ))}
        </div>
        {err.lines ? (
          <p role="alert" className={styles.status}>
            {err.lines}
          </p>
        ) : null}
        <div className={styles.actions} style={{ marginTop: 16 }}>
          <Button variant="secondary" onClick={addLine} disabled={rows.length >= MAX_LINES}>
            Add a line
          </Button>
          {rows.length >= MAX_LINES ? (
            <span className={styles.status}>A request takes up to {MAX_LINES} lines.</span>
          ) : null}
        </div>
      </Panel>

      <div className={styles.actions}>
        <Button type="submit" disabled={pending}>
          {submitLabel}
        </Button>
        <LinkButton href={cancelHref} variant="ghost">
          Cancel
        </LinkButton>
        {pending ? (
          <span role="status" className={styles.status}>
            Saving the request
          </span>
        ) : null}
      </div>
    </form>
  );
}
