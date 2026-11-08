'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Panel } from '@/components/ui/panel';

import { previewQuoteAction, saveDraftAction, submitQuoteAction } from './actions';
import { ApprovalPanel } from './approval-panel';
import type { FailureKind } from './failure';
import { LinesSection } from './lines-section';
import {
  CURRENCY_OPTIONS,
  newLine,
  newMilestone,
  submitBlocker,
  type BuilderValues,
  type Currency,
  type DiscountMode,
  type LineValues,
  type MilestoneValues,
} from './model';
import styles from './quote-builder.module.css';
import { ScheduleSection } from './schedule-section';
import type { PaymentTerm, PreviewResult, TaxCode } from './schemas';
import { TotalsPanel, type PreviewState } from './totals-panel';

export type BuilderTarget =
  | { mode: 'create'; opportunityId: string }
  | {
      mode: 'edit';
      quotationId: string;
      versionId: string;
      /** The row version the page loaded; a save with an older one gets a 409. */
      expectedVersion: number;
    };

export interface ContactOption {
  id: string;
  label: string;
}

interface Notice {
  tone: 'error' | 'warning' | 'success';
  title?: string | undefined;
  text: string;
  /** Offer a reload (a stale row version). */
  reload?: boolean;
}

interface PreviewView {
  state: PreviewState;
  preview: PreviewResult | null;
  message?: string | undefined;
}

/** What the platform said is wrong with a field, in words; the API's own wording is for logs. */
const FIELD_TEXT: Record<string, string> = {
  description: 'Describe the line, up to 500 characters.',
  uom: 'Enter a unit such as nos, hours or lot.',
  quantity: 'Enter a quantity above zero, up to 4 decimals.',
  unitPrice: 'Enter a rate of zero or more, up to 2 decimals.',
  taxCodeId: 'Choose a tax code.',
  issueDate: 'Choose the issue date.',
  validUntil: 'Valid until must be a date on or after the issue date.',
  currency: 'Choose NPR, INR or USD.',
  value: 'Enter a valid discount: a percentage up to 100, or an amount of zero or more.',
  label: 'Name the milestone.',
  percent: 'Enter a percentage such as 40 or 33.33.',
};

function friendlyErrors(raw: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(raw ?? {})) {
    const last = path.split('.').at(-1) ?? '';
    out[path] = FIELD_TEXT[last] ?? message;
  }
  return out;
}

const DISCOUNT_LABEL: Record<DiscountMode, string> = {
  none: 'No discount',
  pct: 'Percentage',
  amount: 'Fixed amount',
};

/**
 * The quotation builder: eight sections, one form. A client island because lines and milestones
 * are edited in place, but it holds no data of its own beyond what is typed: totals and the
 * approval route come back from the platform through `previewQuoteAction` after a short pause
 * and are shown as received. Saving is explicit; leaving with unsaved edits asks first.
 */
export function QuoteBuilder({
  target,
  initial,
  numberLabel,
  context,
  contacts,
  taxCodes,
  paymentTerms,
  savedNotice = false,
}: {
  target: BuilderTarget;
  initial: BuilderValues;
  /** Display number such as "QT-2082-0042 Rev 2"; absent before the first save. */
  numberLabel?: string | undefined;
  /** Section 1's read-only customer and opportunity facts (rendered on the server). */
  context: ReactNode;
  /** null when the contact list failed to load. */
  contacts: readonly ContactOption[] | null;
  taxCodes: readonly TaxCode[] | null;
  paymentTerms: readonly PaymentTerm[] | null;
  savedNotice?: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<BuilderValues>(initial);
  const [rowVersion, setRowVersion] = useState(target.mode === 'edit' ? target.expectedVersion : 0);
  const savedRef = useRef(JSON.stringify(initial));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'submit'>(null);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(
    savedNotice ? { tone: 'success', text: 'Draft saved.' } : null,
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [view, setView] = useState<PreviewView>(
    target.mode === 'create'
      ? { state: 'needs_save', preview: null }
      : { state: 'loading', preview: null },
  );
  const noticeRef = useRef<HTMLDivElement>(null);
  const keyCounter = useRef(1000);
  const leaving = useRef(false);
  const latest = useRef(values);
  useEffect(() => {
    latest.current = values;
  });
  const nextKey = (prefix: string) => `${prefix}${++keyCounter.current}`;

  const edit = useCallback((patch: (v: BuilderValues) => BuilderValues) => {
    setValues((v) => {
      const next = patch(v);
      setDirty(JSON.stringify(next) !== savedRef.current);
      return next;
    });
    setNotice((n) => (n?.tone === 'success' ? null : n));
    setConfirming(false);
  }, []);

  const set =
    <K extends keyof BuilderValues>(key: K) =>
    (value: BuilderValues[K]) =>
      edit((v) => ({ ...v, [key]: value }));

  // ---- Totals and approval route: ask the platform, show what it says ----------------------

  const previewKey = JSON.stringify([
    values.currency,
    values.discountMode,
    values.discountValue,
    values.lines.map((l) => [l.description, l.uom, l.quantity, l.unitPrice, l.taxCodeId]),
  ]);
  const firstPreview = useRef(true);

  useEffect(() => {
    if (target.mode !== 'edit') return;
    if (latest.current.lines.length === 0) {
      setView({
        state: 'incomplete',
        preview: null,
        message: 'Add a line to see the totals and the approval route.',
      });
      return;
    }
    // A newer edit (or leaving the page) cancels this run, so a slow answer never overwrites a
    // fresher one.
    let cancelled = false;
    setView((prev) => ({ state: 'loading', preview: prev.preview }));
    const delay = firstPreview.current ? 0 : 600;
    firstPreview.current = false;

    async function run(quotationId: string, versionId: string) {
      let next: PreviewView;
      try {
        const res = await previewQuoteAction({
          quotationId,
          versionId,
          values: latest.current,
        });
        next = res.ok
          ? { state: 'ready', preview: res.preview }
          : {
              state: res.kind === 'invalid' ? 'incomplete' : 'error',
              preview: null,
              message: res.message,
            };
      } catch {
        next = {
          state: 'error',
          preview: null,
          message: 'The platform did not respond. The totals could not be worked out; try again.',
        };
      }
      if (!cancelled) setView(next);
    }

    const timer = setTimeout(() => {
      void run(target.quotationId, target.versionId);
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `target` is stable for the life of the page; the key captures everything the preview reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  const lineAmounts = useMemo(() => {
    const map = new Map<number, string>();
    if (view.state === 'ready')
      for (const l of view.preview?.lines ?? []) map.set(l.lineNo, l.gross);
    return map;
  }, [view]);

  // ---- Leaving with unsaved edits ----------------------------------------------------------

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (leaving.current) return;
      e.preventDefault();
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!a || a.getAttribute('target') === '_blank' || a.getAttribute('href')?.startsWith('#')) {
        return;
      }
      if (!window.confirm('You have unsaved changes to this quotation. Leave without saving?')) {
        e.preventDefault();
        e.stopPropagation();
      } else {
        leaving.current = true;
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty]);

  // ---- Actions -----------------------------------------------------------------------------

  const fail = (kind: FailureKind, message: string, fields?: Record<string, string>) => {
    setErrors(friendlyErrors(fields));
    setNotice({
      tone: kind === 'stale' || kind === 'stale_fx' ? 'warning' : 'error',
      title:
        kind === 'stale'
          ? 'This quotation changed'
          : kind === 'stale_fx'
            ? 'The exchange rate is out of date'
            : kind === 'invalid'
              ? 'Some fields need attention'
              : undefined,
      text: message,
      reload: kind === 'stale',
    });
    requestAnimationFrame(() => noticeRef.current?.focus());
  };

  async function save() {
    if (busy) return;
    setBusy('save');
    setErrors({});
    setNotice(null);
    try {
      const res = await saveDraftAction(
        target.mode === 'create'
          ? { mode: 'create', opportunityId: target.opportunityId, values }
          : {
              mode: 'update',
              quotationId: target.quotationId,
              versionId: target.versionId,
              expectedVersion: rowVersion,
              values,
            },
      );
      if (res.ok) {
        setRowVersion(res.version);
        savedRef.current = JSON.stringify(values);
        setDirty(false);
        setNotice({ tone: 'success', text: 'Draft saved.' });
      } else {
        fail(res.kind, res.message, res.fieldErrors);
      }
    } catch {
      // A create that succeeds redirects (Next throws to navigate); a real failure lands here.
      if (target.mode === 'edit') {
        fail('error', 'The platform did not respond. Nothing was saved; try again in a moment.');
      }
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    if (target.mode !== 'edit' || busy) return;
    setBusy('submit');
    setConfirming(false);
    setNotice(null);
    try {
      const res = await submitQuoteAction({
        quotationId: target.quotationId,
        versionId: target.versionId,
        expectedVersion: rowVersion,
        values,
      });
      if (res.ok) {
        leaving.current = true;
        router.push(`/quotations/${target.quotationId}/edit?submitted=1`);
        router.refresh();
      } else {
        fail(res.kind, res.message, res.fieldErrors);
      }
    } catch {
      fail('error', 'The platform did not respond. Nothing was submitted; try again in a moment.');
    } finally {
      setBusy(null);
    }
  }

  const blocker = target.mode === 'edit' ? submitBlocker(values, { dirty }) : null;
  const canSubmit = target.mode === 'edit' && blocker === null && !busy;
  const routeBlocked = view.preview?.route.blocked ?? false;
  const submitDisabled = !canSubmit || routeBlocked;
  const hintText =
    target.mode === 'create'
      ? 'After the first save you can see the totals and the approval route, and submit.'
      : (blocker ??
        (routeBlocked
          ? 'Nobody can approve a step of the route yet, so submitting is refused until an administrator fixes it.'
          : null));

  const actionBar = (where: 'top' | 'bottom') => (
    <div className={styles.actionBar}>
      <div className={styles.actions}>
        <Button onClick={() => void save()} disabled={busy !== null} aria-busy={busy === 'save'}>
          {busy === 'save' ? 'Saving' : 'Save draft'}
        </Button>
        {target.mode === 'edit' ? (
          <Button
            variant="secondary"
            onClick={() => setConfirming(true)}
            disabled={submitDisabled}
            aria-describedby={hintText ? `submit-hint-${where}` : undefined}
          >
            {busy === 'submit' ? 'Submitting' : 'Submit for approval'}
          </Button>
        ) : null}
        <span className={styles.status} role="status">
          {dirty ? 'Unsaved changes' : target.mode === 'edit' ? 'All changes saved' : ''}
        </span>
      </div>
      {hintText ? (
        <p id={`submit-hint-${where}`} className={styles.muted}>
          {hintText}
        </p>
      ) : null}
    </div>
  );

  return (
    <div className={styles.layout}>
      <div className={styles.main}>
        {numberLabel ? (
          <p className={styles.muted}>
            Editing <strong>{numberLabel}</strong>
          </p>
        ) : null}

        {notice ? (
          <Alert
            ref={noticeRef}
            tabIndex={-1}
            tone={notice.tone}
            title={notice.title}
            role={notice.tone === 'success' ? 'status' : 'alert'}
            actions={
              notice.reload ? (
                <Button
                  size="small"
                  variant="secondary"
                  onClick={() => {
                    leaving.current = true;
                    window.location.reload();
                  }}
                >
                  Reload the latest version
                </Button>
              ) : null
            }
          >
            {notice.text}
          </Alert>
        ) : null}

        {confirming ? (
          <Alert
            tone="info"
            role="alertdialog"
            aria-label="Confirm submit"
            title="Submit this quotation for approval?"
            actions={
              <>
                <Button size="small" onClick={() => void submit()}>
                  Yes, submit
                </Button>
                <Button size="small" variant="secondary" onClick={() => setConfirming(false)}>
                  Keep editing
                </Button>
              </>
            }
          >
            It cannot be edited while approvers have it. You can pull it back to Returned if it
            needs a change.
          </Alert>
        ) : null}

        {actionBar('top')}

        <Panel title="1. Customer and opportunity">
          <div className={styles.sectionBody}>
            {context}
            <Field
              label="Contact"
              hint={
                contacts === null
                  ? 'The contact list did not load. Reload the page to choose one.'
                  : 'Who at the customer receives this quotation.'
              }
              error={errors['contactId']}
            >
              {(control) => (
                <Select
                  value={values.contactId}
                  onChange={(e) => set('contactId')(e.target.value)}
                  disabled={contacts === null}
                  {...control}
                >
                  <option value="">No contact chosen</option>
                  {(contacts ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </Panel>

        <Panel title="2. Validity and currency">
          <div className={styles.sectionBody}>
            <div className={styles.grid2}>
              <Field label="Issue date" error={errors['issueDate']}>
                {(control) => (
                  <Input
                    type="date"
                    required
                    value={values.issueDate}
                    onChange={(e) => set('issueDate')(e.target.value)}
                    {...control}
                  />
                )}
              </Field>
              <Field label="Valid until" error={errors['validUntil']}>
                {(control) => (
                  <Input
                    type="date"
                    required
                    min={values.issueDate || undefined}
                    value={values.validUntil}
                    onChange={(e) => set('validUntil')(e.target.value)}
                    {...control}
                  />
                )}
              </Field>
            </div>
            <Field
              label="Currency"
              hint={
                values.currency === 'NPR'
                  ? 'Nepalese rupee is the default.'
                  : 'The platform converts to NPR with the latest rate Finance entered. If that rate is older than 7 days, saving or submitting is refused until it is refreshed.'
              }
              error={errors['currency']}
            >
              {(control) => (
                <Select
                  value={values.currency}
                  onChange={(e) => set('currency')(e.target.value as Currency)}
                  {...control}
                >
                  {CURRENCY_OPTIONS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </Panel>

        <Panel
          title="3. Lines"
          description="Quantity, unit, rate and tax code. The discount is set once, in section 4."
        >
          <LinesSection
            lines={values.lines}
            currency={values.currency}
            taxCodes={taxCodes}
            lineAmounts={lineAmounts}
            errors={errors}
            onChange={(key, patch: Partial<LineValues>) =>
              edit((v) => ({
                ...v,
                lines: v.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)),
              }))
            }
            onAdd={() => edit((v) => ({ ...v, lines: [...v.lines, newLine(nextKey('l'))] }))}
            onRemove={(key) => edit((v) => ({ ...v, lines: v.lines.filter((l) => l.key !== key) }))}
          />
        </Panel>

        <Panel title="4. Discount" description="One discount for the whole quotation.">
          <div className={styles.sectionBody}>
            <div className={styles.grid2}>
              <Field label="Discount type">
                {(control) => (
                  <Select
                    value={values.discountMode}
                    onChange={(e) =>
                      edit((v) => ({
                        ...v,
                        discountMode: e.target.value as DiscountMode,
                        discountValue: e.target.value === 'none' ? '' : v.discountValue,
                      }))
                    }
                    {...control}
                  >
                    {(Object.keys(DISCOUNT_LABEL) as DiscountMode[]).map((m) => (
                      <option key={m} value={m}>
                        {DISCOUNT_LABEL[m]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              {values.discountMode !== 'none' ? (
                <Field
                  label={
                    values.discountMode === 'pct'
                      ? 'Discount (%)'
                      : `Discount amount (${values.currency})`
                  }
                  hint="A discount above 12% of the subtotal needs extra approval."
                  error={errors['discount.value'] ?? errors['discount']}
                >
                  {(control) => (
                    <Input
                      inputMode="decimal"
                      autoComplete="off"
                      className={styles.numInput}
                      value={values.discountValue}
                      onChange={(e) => set('discountValue')(e.target.value)}
                      {...control}
                    />
                  )}
                </Field>
              ) : null}
            </div>
          </div>
        </Panel>

        <Panel title="5. Payment schedule" description="Milestones must add up to 100%.">
          <ScheduleSection
            paymentTermId={values.paymentTermId}
            paymentTerms={paymentTerms}
            milestones={values.schedule}
            errors={errors}
            onTerm={set('paymentTermId')}
            onChange={(key, patch: Partial<MilestoneValues>) =>
              edit((v) => ({
                ...v,
                schedule: v.schedule.map((m) => (m.key === key ? { ...m, ...patch } : m)),
              }))
            }
            onAdd={() =>
              edit((v) => ({ ...v, schedule: [...v.schedule, newMilestone(nextKey('m'))] }))
            }
            onRemove={(key) =>
              edit((v) => ({ ...v, schedule: v.schedule.filter((m) => m.key !== key) }))
            }
          />
        </Panel>

        <Panel title="6. Terms">
          <div className={styles.sectionBody}>
            <Field label="Scope" hint="What is included." error={errors['scope']}>
              {(control) => (
                <Textarea
                  rows={4}
                  maxLength={10000}
                  value={values.scope}
                  onChange={(e) => set('scope')(e.target.value)}
                  {...control}
                />
              )}
            </Field>
            <Field label="Assumptions" error={errors['assumptions']}>
              {(control) => (
                <Textarea
                  rows={3}
                  maxLength={10000}
                  value={values.assumptions}
                  onChange={(e) => set('assumptions')(e.target.value)}
                  {...control}
                />
              )}
            </Field>
            <Field label="Exclusions" hint="What is not included." error={errors['exclusions']}>
              {(control) => (
                <Textarea
                  rows={3}
                  maxLength={10000}
                  value={values.exclusions}
                  onChange={(e) => set('exclusions')(e.target.value)}
                  {...control}
                />
              )}
            </Field>
            <Field label="Delivery timeline" error={errors['deliveryTimeline']}>
              {(control) => (
                <Textarea
                  rows={2}
                  maxLength={2000}
                  value={values.deliveryTimeline}
                  onChange={(e) => set('deliveryTimeline')(e.target.value)}
                  {...control}
                />
              )}
            </Field>
          </div>
        </Panel>

        {actionBar('bottom')}
      </div>

      <div
        className={styles.side}
        role="region"
        aria-label="Totals and approval requirements"
        tabIndex={0}
      >
        <TotalsPanel
          currency={values.currency}
          state={view.state}
          preview={view.preview}
          message={view.message}
        />
        <ApprovalPanel state={view.state} preview={view.preview} message={view.message} />
      </div>
    </div>
  );
}
