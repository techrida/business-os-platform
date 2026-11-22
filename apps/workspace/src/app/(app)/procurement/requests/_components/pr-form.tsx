'use client';

import { PR_REQUEST_TYPES, type CostCenter, type Currency } from '@bos/contracts';
import { useActionState, useEffect, useRef, useState, type ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Icon } from '@/components/ui/icon';
import { MoneyInput, QuantityInput } from '@/components/ui/number-input';
import { PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { currencyChoices } from '@/lib/enabled-currencies';

import { emptyLine, type LineValues, type PrValues } from '../_lib/forms';
import { REQUEST_TYPE_LABEL } from '../_lib/model';
import type { PrFormState } from '../_lib/state';
import { ProcurementFormActions } from '../../form-actions';
import styles from '../requests.module.css';
import lines from './pr-lines.module.css';

const WIDE = styles.wide ?? '';
const MAX_LINES = 200;

/** Card heading with its Figma eyebrow ("01 · The basics"). The eyebrow is decoration. */
function SectionTitle({ eyebrow, children }: { eyebrow: string; children: ReactNode }) {
  return (
    <>
      <span className={lines.eyebrow} aria-hidden="true">
        {eyebrow}
      </span>
      {children}
    </>
  );
}

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
  requestLabel,
  cancelHref,
  reloadHref,
  costCenters,
  enabledCurrencies,
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
  requestLabel?: string;
  cancelHref: string;
  reloadHref: string;
  costCenters: CostCenter[];
  /**
   * The currencies the company has switched on (`currency.enabled`, D44), read once on the server. An
   * edited request keeps its own currency in the list even after it was switched off.
   */
  enabledCurrencies: readonly Currency[];
}) {
  const [state, formAction, pending] = useActionState<PrFormState, FormData>(action, {
    key: idempotencyKey,
    errors: {},
  });
  const [values, setValues] = useState<PrValues>(initial);
  const currencyOptions = currencyChoices(
    enabledCurrencies,
    mode === 'edit' ? initial.currency : undefined,
  );
  const nextUid = useRef(initial.lines.length);
  const [rows, setRows] = useState<Row[]>(() => initial.lines.map((line, uid) => ({ uid, line })));
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  type HeaderKey = Exclude<keyof PrValues, 'lines' | 'isEmergency'>;
  const set =
    (field: HeaderKey) =>
    (e: { target: { value: string } }): void =>
      setValues((v) => ({ ...v, [field]: e.target.value }));
  const setLineValue = (
    uid: number,
    field: Exclude<keyof LineValues, 'requiresSerials'>,
    value: string,
  ): void =>
    setRows((rs) =>
      rs.map((r) => (r.uid === uid ? { ...r, line: { ...r.line, [field]: value } } : r)),
    );
  const setLine =
    (uid: number, field: Exclude<keyof LineValues, 'requiresSerials'>) =>
    (e: { target: { value: string } }): void =>
      setLineValue(uid, field, e.target.value);
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
      <PageHeader
        title={
          mode === 'edit' ? `Edit ${requestLabel ?? 'purchase request'}` : 'New purchase request'
        }
        description={
          mode === 'create'
            ? 'Save a draft and submit it to the department head when it is ready.'
            : undefined
        }
        actions={
          <ProcurementFormActions
            cancelHref={cancelHref}
            submitLabel={submitLabel}
            disabled={pending || !costCenters.some((c) => c.active || c.id === values.costCenterId)}
          />
        }
      />
      {pending ? (
        <span className="sr-only" role="status">
          Saving the request
        </span>
      ) : null}
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

      <Panel title={<SectionTitle eyebrow="01 · The basics">Request details</SectionTitle>}>
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
              <DatePicker
                name="requiredBy"
                value={values.requiredBy}
                onChange={(iso) => setValues((v) => ({ ...v, requiredBy: iso }))}
                // The form returns through a server action, which resets it: hold a partly typed date
                // here, so its segments stay and "Finish the date" names the problem.
                validation="hold"
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
          <Field
            label="Cost centre"
            error={err.costCenterId}
            hint={
              costCenters.some((c) => c.active)
                ? undefined
                : 'No active cost centres. Ask an administrator to configure one.'
            }
          >
            {(control) => (
              <Select
                name="costCenterId"
                value={values.costCenterId}
                onChange={set('costCenterId')}
                required
                {...control}
              >
                <option value="">Choose a cost centre</option>
                {costCenters
                  .filter((c) => c.active || c.id === values.costCenterId)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.code} {'\u00b7'} {c.name}
                      {c.active ? '' : ' (inactive)'}
                    </option>
                  ))}
              </Select>
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
                {currencyOptions.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.enabled ? c.value : `${c.value} (not enabled)`}
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
        title={<SectionTitle eyebrow="02 · The items">Line items</SectionTitle>}
        description="What is needed, with your estimate of the unit price. The platform works out the totals when you save."
      >
        <div className={lines.editor}>
          {/* The column heads. Each line is a group named "Line 1" and its fields keep their own labels,
              hidden on wide cards, for screen readers. */}
          <div className={lines.head} aria-hidden="true">
            <span>#</span>
            <span className={lines.headFields}>
              <span>Item</span>
              <span>Specification</span>
              <span>Unit</span>
              <span>Quantity</span>
              <span>Unit price ({values.currency})</span>
            </span>
            <span className={lines.headAction}>{rows.length > 1 ? 'Action' : null}</span>
          </div>
          <div className={lines.lines}>
            {rows.map((row, i) => {
              const no = i + 1;
              return (
                <div
                  key={row.uid}
                  className={lines.line}
                  role="group"
                  aria-labelledby={`pr-line-${row.uid}`}
                >
                  <span className={lines.lineNo} id={`pr-line-${row.uid}`}>
                    <span className={lines.lineWord}>Line </span>
                    {no}
                  </span>
                  <div className={lines.fields}>
                    <Field label="Description" error={err[`lines.${i}.description`]}>
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
                    <Field label="Specification (optional)" error={err[`lines.${i}.specification`]}>
                      {(control) => (
                        <Textarea
                          name={`lines.${i}.specification`}
                          value={row.line.specification}
                          onChange={setLine(row.uid, 'specification')}
                          rows={1}
                          maxLength={2000}
                          {...control}
                        />
                      )}
                    </Field>
                    <Field label="Unit" error={err[`lines.${i}.uom`]}>
                      {(control) => (
                        <Input
                          name={`lines.${i}.uom`}
                          value={row.line.uom}
                          onChange={setLine(row.uid, 'uom')}
                          maxLength={20}
                          placeholder="pcs, hrs, lot"
                          required
                          {...control}
                        />
                      )}
                    </Field>
                    <Field label="Quantity" error={err[`lines.${i}.quantity`]}>
                      {(control) => (
                        <QuantityInput
                          name={`lines.${i}.quantity`}
                          value={row.line.quantity}
                          onValueChange={(plain) => setLineValue(row.uid, 'quantity', plain)}
                          uom={row.line.uom.trim() || undefined}
                          currency={values.currency as Currency}
                          required
                          {...control}
                        />
                      )}
                    </Field>
                    <Field
                      label="Estimated unit price"
                      error={err[`lines.${i}.estimatedUnitPrice`]}
                    >
                      {(control) => (
                        <MoneyInput
                          name={`lines.${i}.estimatedUnitPrice`}
                          value={row.line.estimatedUnitPrice}
                          onValueChange={(plain) =>
                            setLineValue(row.uid, 'estimatedUnitPrice', plain)
                          }
                          currency={values.currency as Currency}
                          required
                          {...control}
                        />
                      )}
                    </Field>
                    {values.requestType === 'goods' ? (
                      <label className={`${styles.check} ${lines.serials}`}>
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
                  </div>
                  {rows.length > 1 ? (
                    <Button
                      className={lines.remove}
                      variant="ghost"
                      size="small"
                      onClick={() => removeLine(row.uid)}
                      aria-label={`Remove line ${no}`}
                    >
                      <Icon name="x" size={18} />
                    </Button>
                  ) : null}
                </div>
              );
            })}
          </div>
          {err.lines ? (
            <p role="alert" className={styles.status}>
              {err.lines}
            </p>
          ) : null}
          <div className={lines.add}>
            <Button variant="tertiary" onClick={addLine} disabled={rows.length >= MAX_LINES}>
              <span aria-hidden="true" className={lines.plus}>
                +
              </span>{' '}
              Add items
            </Button>
            {rows.length >= MAX_LINES ? (
              <span className={styles.status}>A request takes up to {MAX_LINES} lines.</span>
            ) : null}
          </div>
        </div>
      </Panel>
    </form>
  );
}
