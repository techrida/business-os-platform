'use client';

import type { TermPreset } from '@bos/contracts';
import { Dec, formatMoney } from '@bos/locale';
import { unstable_rethrow, useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Select } from '@/components/ui/field';

import { ContactPicker, type ContactCreate } from '../customers/contact-picker';
import { MoneyInput, PercentInput } from '@/components/ui/number-input';
import { PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { toast } from '@/components/ui/toast';
import { currencyChoices } from '@/lib/enabled-currencies';

import { previewQuoteAction, saveDraftAction, submitQuoteAction } from './actions';
import { ApprovalPanel, ApprovalSteps } from './approval-panel';
import type { FailureKind } from './failure';
import { leaveAction } from './leave-link';
import { LinesSection } from './lines-section';
import {
  currencyChoiceText,
  currencyProblem,
  newMilestone,
  plainNumber,
  scheduleMessage,
  scheduleState,
  submitBlocker,
  type BuilderValues,
  type Currency,
  type DiscountMode,
  type LineValues,
  type MilestoneValues,
} from './model';
import styles from './quote-builder.module.css';
import { ScheduleSection, type AmountDraft } from './schedule-section';
import type { PaymentTerm, PreviewResult, TaxCode } from './schemas';
import { TermsField } from './terms-field';
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
  /** The contact's name and what else a search matches (title, email); the picker falls back to `label`. */
  name?: string;
  detail?: string | undefined;
}

interface PreviewView {
  key?: string;
  currency?: Currency;
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
  value: 'Enter a valid discount: a percentage up to 100, or an amount of zero or more.',
  label: 'Name the milestone.',
  percent: 'Enter a percentage such as 40 or 33.33.',
};

function friendlyErrors(
  raw: Record<string, string> | undefined,
  text: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, message] of Object.entries(raw ?? {})) {
    const last = path.split('.').at(-1) ?? '';
    out[path] = text[last] ?? FIELD_TEXT[last] ?? message;
  }
  return out;
}

const noSubscription = () => () => {};
const onClient = () => true;
const onServer = () => false;

/** How long the totals wait for the platform before saying they did not load (TR-Q8). */
export const PREVIEW_TIMEOUT_MS = 20_000;

const PLAIN_DECIMAL = /^(\d+\.?\d*|\.\d+)$/;

const decimalOf = (raw: string): Dec | null => {
  const plain = plainNumber(raw);
  return PLAIN_DECIMAL.test(plain) ? new Dec(plain) : null;
};

/**
 * The amount the quotation discount applies to, priced as the platform does: each line's quantity
 * times rate rounded half up to 2 decimals, added up. Null while there is no line or a line has no
 * usable number, so nothing is worked out from a guess.
 */
function discountBase(lines: readonly LineValues[]): Dec | null {
  if (lines.length === 0) return null;
  let base = new Dec(0);
  for (const line of lines) {
    const quantity = decimalOf(line.quantity);
    const rate = decimalOf(line.unitPrice);
    if (quantity === null || rate === null) return null;
    base = base.plus(quantity.times(rate).toDecimalPlaces(2, Dec.ROUND_HALF_UP));
  }
  return base;
}

/**
 * Both discount fields from the one that was typed last (`mode`, `value`). The other is worked out
 * from the base: an amount rounded half up to 2 decimals, a percentage to at most 4, shortest form.
 * `overBase` is an amount larger than the base; its percentage is then left blank.
 */
function discountPair(
  mode: DiscountMode,
  value: string,
  base: Dec | null,
): { pct: string; amount: string; overBase: boolean } {
  const typed = decimalOf(value);
  if (mode === 'none' || plainNumber(value) === '') return { pct: '', amount: '', overBase: false };
  if (mode === 'pct') {
    const amount =
      base === null || typed === null
        ? ''
        : base.times(typed).div(100).toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2);
    return { pct: value, amount, overBase: false };
  }
  const overBase = base !== null && typed !== null && typed.gt(base);
  const pct =
    base === null || typed === null || overBase || base.isZero()
      ? ''
      : typed.times(100).div(base).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed();
  return { pct, amount: value, overBase };
}

/**
 * The builder holds edits locally and requests pricing and the approval route from the server.
 * Saving is explicit; leaving with unsaved edits asks first.
 */
export function QuoteBuilder({
  target,
  title,
  description,
  status,
  cancelHref,
  notice,
  initial,
  context,
  contacts,
  createContact = null,
  taxCodes,
  paymentTerms,
  termPresets,
  canAddTerms = false,
  enabledCurrencies,
  idempotencyKey,
  savedNotice = false,
}: {
  target: BuilderTarget;
  title: string;
  description?: string;
  status?: ReactNode;
  cancelHref: string;
  notice?: ReactNode;
  initial: BuilderValues;
  /** Section 1's read-only customer and opportunity facts (rendered on the server). */
  context: ReactNode;
  /** null when the contact list failed to load. */
  contacts: readonly ContactOption[] | null;
  /** When set, the Contact picker's last row adds a contact to the customer and chooses it. */
  createContact?: ContactCreate | null;
  taxCodes: readonly TaxCode[] | null;
  paymentTerms: readonly PaymentTerm[] | null;
  /** Saved term sets for the Terms fields; null when they could not be loaded (no dropdown is shown). */
  termPresets?: readonly TermPreset[] | null;
  /**
   * True when the session holds `admin.settings.write` (the Founder): the saved-terms dropdowns then
   * end with "Add more", which opens Settings > Saved terms. Decided on the server; the API still
   * enforces who may edit a set.
   */
  canAddTerms?: boolean;
  /**
   * The currencies the company has switched on (`currency.enabled`, D44), read once on the server.
   * The picker offers only these, plus a saved quotation's own currency if it was switched off since.
   */
  enabledCurrencies: readonly Currency[];
  /** Made once per page render on the server; the actions hand back the key the next try uses. */
  idempotencyKey: string;
  savedNotice?: boolean;
}) {
  const router = useRouter();
  const [values, setValues] = useState<BuilderValues>(initial);
  const [rowVersion, setRowVersion] = useState(target.mode === 'edit' ? target.expectedVersion : 0);
  // Kept when the outcome is unknown (the action threw), rotated by the action after a definite 4xx.
  const [key, setKey] = useState(idempotencyKey);
  const [saved, setSaved] = useState(() => JSON.stringify(initial));
  const [pricedIssueDate, setPricedIssueDate] = useState(initial.issueDate);
  const [amountDrafts, setAmountDrafts] = useState<Record<string, AmountDraft>>({});
  const hasAmountError = Object.values(amountDrafts).some((draft) => Boolean(draft.error));
  const dirty = JSON.stringify(values) !== saved || hasAmountError;
  const [busy, setBusy] = useState<null | 'save' | 'submit'>(null);
  const [confirming, setConfirming] = useState(false);
  const [stale, setStale] = useState(false);
  const [scheduleAttempted, setScheduleAttempted] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [lastView, setLastView] = useState<PreviewView>({ state: 'loading', preview: null });
  // False on the server and until this page's script has run. Until then no totals request can have
  // been made, so the panel must not claim one is on its way (TR-Q8: a page whose script failed to
  // load kept saying "Updating totals" for ever).
  const hydrated = useSyncExternalStore(noSubscription, onClient, onServer);
  // Bumped by Try again: the same inputs are priced once more.
  const [attempt, setAttempt] = useState(0);
  const retryNow = useRef(false);

  // A saved quotation keeps its own currency even after it is switched off; the API accepts it unchanged.
  const keptCurrency = useMemo(
    () => (target.mode === 'edit' ? (JSON.parse(saved) as BuilderValues).currency : undefined),
    [target.mode, saved],
  );
  // A currency that is neither (a create prefilled with one) is listed too, so the picker shows the
  // real value, and saving is stopped with the reason until another is chosen.
  const currencyOptions = currencyChoices(enabledCurrencies, keptCurrency ?? values.currency);
  const onCurrencies = currencyOptions.filter((c) => c.enabled).map((c) => c.value);
  const currencyText = currencyChoiceText(onCurrencies);
  const currencyOff = !onCurrencies.includes(values.currency);

  useEffect(() => {
    if (savedNotice) toast.success('Draft saved.', { id: 'quotation-draft-saved' });
  }, [savedNotice]);

  const keyCounter = useRef(1000);
  const leaving = useRef(false);
  // The link the user clicked while edits are unsaved; set while the leave-without-saving dialog is open.
  const [leaveHref, setLeaveHref] = useState<string | null>(null);
  const latest = useRef(values);
  useEffect(() => {
    latest.current = values;
  });
  const nextKey = (prefix: string) => `${prefix}${++keyCounter.current}`;

  const edit = useCallback((patch: (v: BuilderValues) => BuilderValues) => {
    setValues(patch);
    setConfirming(false);
  }, []);

  function setAmountDraft(key: string, next: AmountDraft | undefined) {
    setAmountDrafts((current) => {
      if (next) return { ...current, [key]: next };
      if (!Object.hasOwn(current, key)) return current;
      const drafts = { ...current };
      delete drafts[key];
      return drafts;
    });
  }

  const set =
    <K extends keyof BuilderValues>(key: K) =>
    (value: BuilderValues[K]) =>
      edit((v) => ({ ...v, [key]: value }));

  // ---- Discount: percent and amount side by side ---------------------------------------------
  // The side typed last is the discount sent to the platform (`discountMode` + `discountValue`, the
  // same shape as before); the other side is worked out from the line base and never stored.
  const base = discountBase(values.lines);
  const pair = discountPair(values.discountMode, values.discountValue, base);
  const discountError = errors['discount.value'] ?? errors['discount'];

  const setDiscount =
    (side: 'pct' | 'amount', typed = false) =>
    (raw: string) => {
      if (plainNumber(raw) === '') {
        edit((v) => ({ ...v, discountMode: 'none', discountValue: '' }));
        return;
      }
      // `typed`: the person edited this box, so it becomes the discount even when the number is the
      // one it already showed (typing 100 over a worked-out 100.00).
      // The worked-out side reporting the number it already shows (for example padding on blur) is
      // not a new entry, so it must not take over as the discount.
      if (!typed && side !== values.discountMode) {
        const shown = decimalOf(side === 'pct' ? pair.pct : pair.amount);
        const typed = decimalOf(raw);
        if (shown !== null && typed !== null && shown.eq(typed)) return;
      }
      edit((v) => ({ ...v, discountMode: side, discountValue: raw }));
    };

  // ---- Totals and approval route: ask the platform, show what it says ----------------------

  const previewKey = JSON.stringify([
    attempt,
    pricedIssueDate,
    values.issueDate,
    values.currency,
    values.discountMode,
    // Blur pads `100` to `100.00`; the same amount must not look like a new price request.
    values.discountValue.includes('.')
      ? values.discountValue.replace(/0+$/, '').replace(/\.$/, '')
      : values.discountValue,
    values.lines.map((l) => [
      l.description,
      l.uom,
      l.quantity,
      l.unitPrice,
      l.taxCodeId,
      l.unitCost,
      l.catalogItemId,
    ]),
  ]);
  const firstPreview = useRef(true);
  // The pricing inputs on screen now. A reply is shown whenever it answers them, even if the request
  // that asked was cleaned up meanwhile (TR-Q8: a dropped reply left the totals updating until the next
  // keystroke). A reply for inputs that have since changed is ignored.
  const currentPreviewKey = useRef(previewKey);
  useEffect(() => {
    currentPreviewKey.current = previewKey;
  });

  useEffect(() => {
    const snapshot = latest.current;
    if (
      target.mode !== 'edit' ||
      snapshot.lines.length === 0 ||
      snapshot.issueDate !== pricedIssueDate
    )
      return;

    const delay = firstPreview.current || retryNow.current ? 0 : 600;
    firstPreview.current = false;
    retryNow.current = false;

    async function run(quotationId: string, versionId: string) {
      let next: PreviewView;
      try {
        // A reply that never comes must not leave the panel waiting for ever: after the limit it says
        // so and offers Try again.
        const res = await Promise.race([
          previewQuoteAction({ quotationId, versionId, values: snapshot }),
          new Promise<'timeout'>((resolve) => {
            watchdog = setTimeout(() => resolve('timeout'), PREVIEW_TIMEOUT_MS);
          }),
        ]);
        if (res === 'timeout') throw new Error('timeout');
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
          message: 'The totals did not load. Try again.',
        };
      } finally {
        clearTimeout(watchdog);
      }
      if (currentPreviewKey.current === previewKey) {
        setLastView({ ...next, key: previewKey, currency: snapshot.currency });
      }
    }

    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => void run(target.quotationId, target.versionId), delay);
    return () => {
      clearTimeout(timer);
      // Inputs that change again bring their own limit; a reply to these still lands if it comes.
      clearTimeout(watchdog);
    };
    // The key captures the pricing inputs, including the issue date saved on the server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewKey]);

  const view: PreviewView = useMemo(() => {
    if (target.mode === 'create') return { state: 'needs_save', preview: null };
    if (values.lines.length === 0) {
      return { state: 'incomplete', preview: null, message: 'Add a line to see the totals.' };
    }
    if (values.issueDate !== pricedIssueDate) {
      return {
        state: 'incomplete',
        preview: null,
        message: 'Save the new issue date to update pricing.',
      };
    }
    if (lastView.key === previewKey) return lastView;
    if (!hydrated) return { state: 'starting', preview: null };
    return {
      state: 'loading',
      preview: lastView.currency === values.currency ? lastView.preview : null,
    };
  }, [
    target.mode,
    values.lines.length,
    values.issueDate,
    values.currency,
    pricedIssueDate,
    lastView,
    previewKey,
    hydrated,
  ]);
  const readyPreview = view.state === 'ready' ? view.preview : null;
  // The first-step approver the author chose ('' = anyone eligible). A fresh route that no longer offers
  // the chosen person puts the choice back to anyone eligible rather than submitting a stale name.
  const [approver, setApprover] = useState('');
  const approverOptions = readyPreview?.approverChoice?.options;
  if (approver !== '' && approverOptions && !approverOptions.some((o) => o.userId === approver)) {
    setApprover('');
  }
  const chosenApprover = approverOptions?.find((o) => o.userId === approver);
  const approverChoiceSeq = readyPreview?.approverChoice?.seq;
  const pricedTotal = readyPreview?.totals.total ?? null;
  // An amount draft only has meaning against the total it was typed for. Once pricing is unavailable
  // (for example a new issue date that must be saved first) the amount field is disabled, so a kept
  // draft error would block Save with no way to correct it. The percent keeps its last valid value.
  if (pricedTotal === null && Object.keys(amountDrafts).length > 0) setAmountDrafts({});

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
      if (
        !a ||
        a.getAttribute('target') === '_blank' ||
        a.hasAttribute('download') ||
        a.getAttribute('href')?.startsWith('#')
      ) {
        return;
      }
      // Hold the click and ask in the design-system dialog; confirming then follows the link.
      e.preventDefault();
      e.stopPropagation();
      setLeaveHref((a as HTMLAnchorElement).href);
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
    setErrors(friendlyErrors(fields, { currency: currencyText }));
    setStale(kind === 'stale');
    toast.error(message, { id: 'quotation-action-error' });
  };

  function checkCurrency() {
    const problem = currencyProblem(values.currency, onCurrencies, keptCurrency);
    if (problem === null) return true;
    setErrors({ currency: problem });
    toast.error(problem, { id: 'quotation-action-error' });
    return false;
  }

  function checkSchedule() {
    const problem = scheduleMessage(scheduleState(values.schedule));
    if (problem) {
      setScheduleAttempted(true);
      toast.error(problem, { id: 'quotation-schedule-error' });
      return false;
    }
    if (hasAmountError) {
      toast.error('Correct the milestone amount before continuing.', {
        id: 'quotation-schedule-error',
      });
      return false;
    }
    return true;
  }

  async function save() {
    if (busy || !checkCurrency() || !checkSchedule()) return;
    setBusy('save');
    setErrors({});
    setStale(false);
    try {
      const res = await saveDraftAction(
        target.mode === 'create'
          ? { mode: 'create', opportunityId: target.opportunityId, idempotencyKey: key, values }
          : {
              mode: 'update',
              quotationId: target.quotationId,
              versionId: target.versionId,
              expectedVersion: rowVersion,
              values,
            },
      );
      if (res.ok && res.createdId !== undefined) {
        // A new draft: move to its editor once. Nothing else is set, so this page does not re-render
        // into a half-saved state on the way out.
        leaving.current = true;
        router.replace(`/quotations/${encodeURIComponent(res.createdId)}/edit?saved=1`);
        return;
      }
      if (res.ok) {
        setRowVersion(res.version);
        setSaved(JSON.stringify(values));
        setPricedIssueDate(values.issueDate);
        setScheduleAttempted(false);
        toast.success('Draft saved.', { id: 'quotation-draft-saved' });
      } else {
        if (res.key) setKey(res.key);
        fail(res.kind, res.message, res.fieldErrors);
      }
    } catch (error) {
      unstable_rethrow(error);
      fail('error', 'The save could not be confirmed. Try again.');
    } finally {
      setBusy(null);
    }
  }

  async function submit() {
    if (target.mode !== 'edit' || busy) return;
    setBusy('submit');
    setStale(false);
    try {
      const res = await submitQuoteAction({
        quotationId: target.quotationId,
        versionId: target.versionId,
        expectedVersion: rowVersion,
        idempotencyKey: key,
        values,
        approverUserId: approver === '' ? undefined : approver,
      });
      if (res.ok) {
        leaving.current = true;
        toast.success('Submitted for approval.', { id: 'quotation-submitted' });
        router.push(`/quotations/${target.quotationId}/edit?submitted=1`);
        router.refresh();
      } else {
        if (res.key) setKey(res.key);
        fail(res.kind, res.message, res.fieldErrors);
      }
    } catch (error) {
      unstable_rethrow(error);
      fail('error', 'Submission could not be confirmed. Try again.');
    } finally {
      setBusy(null);
    }
  }

  function openConfirmation(open: boolean) {
    if (!open) {
      setConfirming(false);
      return;
    }
    if (busy || !checkCurrency() || !checkSchedule()) return;
    const blocker = submitBlocker(values, { dirty });
    if (blocker) {
      toast.error(blocker, { id: 'quotation-action-error' });
    } else if (readyPreview?.route.blocked) {
      toast.error('An approval step has no eligible approvers.', { id: 'quotation-action-error' });
    } else {
      setConfirming(true);
    }
  }

  function leaveTo(href: string) {
    leaving.current = true;
    const action = leaveAction(href, window.location.href);
    if (action.kind === 'push') router.push(action.path);
    else window.location.assign(action.href);
  }

  return (
    <div className={styles.layout}>
      <ConfirmDialog
        open={leaveHref !== null}
        onOpenChange={(next) => {
          if (!next) setLeaveHref(null);
        }}
        title="Leave without saving?"
        description="You have unsaved changes to this quotation. They will be lost if you leave."
        confirmLabel="Leave"
        cancelLabel="Keep editing"
        destructive
        onConfirm={() => {
          if (leaveHref !== null) leaveTo(leaveHref);
        }}
      />
      <div className={styles.heading}>
        <PageHeader
          title={title}
          description={description}
          status={status}
          actions={
            <>
              {dirty ? (
                <ConfirmDialog
                  trigger={
                    <Button variant="secondary" disabled={busy !== null}>
                      Cancel
                    </Button>
                  }
                  title="Discard unsaved changes?"
                  description="Changes since the last save will be lost."
                  confirmLabel="Discard changes"
                  cancelLabel="Keep editing"
                  destructive
                  onConfirm={() => {
                    leaving.current = true;
                    router.push(cancelHref);
                  }}
                />
              ) : (
                <LinkButton href={cancelHref} variant="secondary">
                  Cancel
                </LinkButton>
              )}
              <Button
                onClick={() => void save()}
                disabled={busy !== null}
                aria-busy={busy === 'save'}
              >
                {busy === 'save' ? 'Saving' : 'Save draft'}
              </Button>
              {target.mode === 'edit' ? (
                <ConfirmDialog
                  trigger={
                    <Button variant="secondary" disabled={busy !== null}>
                      {busy === 'submit' ? 'Submitting' : 'Submit for approval'}
                    </Button>
                  }
                  open={confirming}
                  onOpenChange={openConfirmation}
                  title="Submit this quotation for approval?"
                  description="Editing is locked while approval is pending. If the approver returns it, you can change it and submit again."
                  confirmLabel="Submit quotation"
                  cancelLabel="Keep editing"
                  onConfirm={submit}
                  size="medium"
                >
                  {readyPreview?.route.steps.length ? (
                    <ApprovalSteps
                      steps={readyPreview.route.steps}
                      assigned={
                        chosenApprover && approverChoiceSeq !== undefined
                          ? { seq: approverChoiceSeq, option: chosenApprover }
                          : null
                      }
                    />
                  ) : null}
                </ConfirmDialog>
              ) : null}
            </>
          }
        />
        <span className={styles.status} role="status">
          {dirty ? 'Unsaved changes' : target.mode === 'edit' ? 'All changes saved' : ''}
        </span>
      </div>
      {notice}

      <fieldset className={styles.main} disabled={busy !== null} aria-label="Quotation fields">
        {stale ? (
          <Alert
            tone="warning"
            title="This quotation changed"
            actions={
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
            }
          >
            Copy any unsaved changes you need before reloading.
          </Alert>
        ) : null}

        <Card className={styles.contextCard}>
          {context}
          <Field
            label="Contact"
            optional
            hint={
              contacts === null
                ? 'The contact list did not load. Reload the page to choose one.'
                : 'Who at the customer receives this quotation.'
            }
            error={errors['contactId']}
          >
            {(control) => (
              <ContactPicker
                control={control}
                name="contactId"
                options={(contacts ?? []).map((c) => ({
                  id: c.id,
                  name: c.name ?? c.label,
                  detail: c.detail,
                }))}
                value={values.contactId}
                onChange={set('contactId')}
                create={contacts === null ? null : createContact}
                disabled={contacts === null}
                placeholder="Search a contact"
              />
            )}
          </Field>
        </Card>

        <Panel
          title="Dates and currency"
          description="The issue date, the valid-until date and the currency are required."
        >
          <div className={styles.grid2}>
            <Field label="Issue date" error={errors['issueDate']}>
              {(control) => (
                <DatePicker
                  required
                  disabled={busy !== null}
                  value={values.issueDate}
                  onChange={set('issueDate')}
                  {...control}
                />
              )}
            </Field>
            <Field label="Valid until" error={errors['validUntil']}>
              {(control) => (
                <DatePicker
                  required
                  disabled={busy !== null}
                  min={values.issueDate || undefined}
                  value={values.validUntil}
                  onChange={set('validUntil')}
                  {...control}
                />
              )}
            </Field>
            <Field
              label="Currency"
              hint={
                currencyOff
                  ? values.currency === keptCurrency
                    ? `${values.currency} has been switched off for your company. This quotation keeps it until you choose another.`
                    : `${values.currency} is not enabled for your company. ${currencyText}`
                  : values.currency === 'NPR'
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
                  {currencyOptions.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.enabled ? c.value : `${c.value} (not enabled)`}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        </Panel>

        <Card as="section" aria-label="Line items" className={styles.linesPanel}>
          <LinesSection
            lines={values.lines}
            currency={values.currency}
            taxCodes={taxCodes}
            lineAmounts={lineAmounts}
            totals={
              <TotalsPanel
                currency={values.currency}
                state={view.state}
                preview={view.preview}
                message={view.message}
                reloadHref={
                  target.mode === 'edit'
                    ? `/quotations/${encodeURIComponent(target.quotationId)}/edit`
                    : undefined
                }
                onRetry={() => {
                  retryNow.current = true;
                  setAttempt((n) => n + 1);
                }}
              />
            }
            errors={errors}
            onSave={(line: LineValues) => {
              if (line.key) {
                const index = values.lines.findIndex((l) => l.key === line.key);
                setErrors((current) =>
                  Object.fromEntries(
                    Object.entries(current).filter(([path]) => !path.startsWith(`lines.${index}.`)),
                  ),
                );
                edit((v) => ({ ...v, lines: v.lines.map((l) => (l.key === line.key ? line : l)) }));
              } else {
                const key = nextKey('l');
                setErrors(({ lines: _error, ...rest }) => rest);
                edit((v) => ({ ...v, lines: [...v.lines, { ...line, key }] }));
              }
            }}
            onRemove={(key) => {
              setErrors((current) =>
                Object.fromEntries(
                  Object.entries(current).filter(([path]) => !path.startsWith('lines.')),
                ),
              );
              edit((v) => ({ ...v, lines: v.lines.filter((l) => l.key !== key) }));
            }}
          />
        </Card>

        <Panel
          title="Discount"
          description="Applies to the full quotation. Enter a percentage or an amount; the other is worked out from the subtotal."
        >
          <div className={styles.sectionBody}>
            <div className={styles.grid2}>
              <Field
                label="Discount %"
                optional
                hint="A discount above 12% of the subtotal needs extra approval."
                error={values.discountMode !== 'amount' ? discountError : undefined}
              >
                {(control) => (
                  <PercentInput
                    value={pair.pct}
                    onValueChange={setDiscount('pct')}
                    onUserEdit={setDiscount('pct', true)}
                    {...control}
                  />
                )}
              </Field>
              <Field
                label={`Discount amount (${values.currency})`}
                optional
                error={
                  values.discountMode === 'amount'
                    ? pair.overBase && base !== null
                      ? `The discount cannot be more than the subtotal of ${formatMoney(base.toFixed(2), values.currency)}.`
                      : discountError
                    : undefined
                }
              >
                {(control) => (
                  <MoneyInput
                    currency={values.currency}
                    value={pair.amount}
                    max={base === null ? undefined : base.toFixed(2)}
                    onValueChange={setDiscount('amount')}
                    onUserEdit={setDiscount('amount', true)}
                    {...control}
                  />
                )}
              </Field>
            </div>
          </div>
        </Panel>

        <Panel
          title="Payment"
          description="Choose a payment term, or split the payment into milestones that add up to 100%."
        >
          <div className={styles.sectionBody}>
            {errors['paymentSchedule'] ? (
              <Alert tone="error" role="alert">
                {errors['paymentSchedule']}
              </Alert>
            ) : null}
            <div className={styles.grid2}>
              <Field
                label="Payment term"
                optional
                hint={
                  paymentTerms === null
                    ? 'The payment terms did not load. Reload the page to choose one.'
                    : "Defaults to the customer's term when left empty."
                }
                error={errors.paymentTermId}
              >
                {(control) => (
                  <Select
                    {...control}
                    value={values.paymentTermId}
                    onChange={(e) => set('paymentTermId')(e.target.value)}
                    disabled={paymentTerms === null}
                  >
                    <option value="">Customer default</option>
                    {(paymentTerms ?? []).map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <ScheduleSection
              milestones={values.schedule}
              currency={values.currency}
              total={pricedTotal}
              amountDrafts={amountDrafts}
              disabled={busy !== null}
              showScheduleErrors={scheduleAttempted}
              onAmountDraft={setAmountDraft}
              errors={errors}
              onChange={(key, patch: Partial<MilestoneValues>) => {
                const index = values.schedule.findIndex((m) => m.key === key);
                setErrors((current) =>
                  Object.fromEntries(
                    Object.entries(current).filter(
                      ([path]) =>
                        path !== 'paymentSchedule' &&
                        !Object.keys(patch).some(
                          (field) => path === `paymentSchedule.${index}.${field}`,
                        ),
                    ),
                  ),
                );
                edit((v) => ({
                  ...v,
                  schedule: v.schedule.map((m) => (m.key === key ? { ...m, ...patch } : m)),
                }));
              }}
              onAdd={() => {
                const milestone = newMilestone(nextKey('m'));
                edit((v) => ({ ...v, schedule: [...v.schedule, milestone] }));
              }}
              onRemove={(key) => {
                setAmountDraft(key, undefined);
                setErrors((current) =>
                  Object.fromEntries(
                    Object.entries(current).filter(([path]) => !path.startsWith('paymentSchedule')),
                  ),
                );
                edit((v) => ({ ...v, schedule: v.schedule.filter((m) => m.key !== key) }));
              }}
            />
          </div>
        </Panel>

        <Panel
          title="Terms"
          {...(termPresets?.length
            ? { description: 'A saved option fills the box; edit the text freely after.' }
            : {})}
        >
          <div className={styles.sectionBody}>
            <Field label="Scope" optional hint="What is included." error={errors['scope']}>
              {(control) => (
                <TermsField
                  kind="scope"
                  presets={termPresets}
                  canAddTerms={canAddTerms}
                  value={values.scope}
                  onChange={set('scope')}
                  maxChars={10000}
                  control={control}
                  disabled={busy !== null}
                  minHeight={160}
                />
              )}
            </Field>
            <Field
              label="Assumptions"
              optional
              hint="What the price and plan rely on."
              error={errors['assumptions']}
            >
              {(control) => (
                <TermsField
                  kind="assumptions"
                  presets={termPresets}
                  canAddTerms={canAddTerms}
                  value={values.assumptions}
                  onChange={set('assumptions')}
                  maxChars={10000}
                  control={control}
                  disabled={busy !== null}
                  minHeight={120}
                />
              )}
            </Field>
            <Field
              label="Exclusions"
              optional
              hint="What is not included."
              error={errors['exclusions']}
            >
              {(control) => (
                <TermsField
                  kind="exclusions"
                  presets={termPresets}
                  canAddTerms={canAddTerms}
                  value={values.exclusions}
                  onChange={set('exclusions')}
                  maxChars={10000}
                  control={control}
                  disabled={busy !== null}
                  minHeight={120}
                />
              )}
            </Field>
            <Field
              label="Delivery timeline"
              optional
              hint="When the work is delivered."
              error={errors['deliveryTimeline']}
            >
              {(control) => (
                <TermsField
                  kind="delivery_timeline"
                  presets={termPresets}
                  canAddTerms={canAddTerms}
                  value={values.deliveryTimeline}
                  onChange={set('deliveryTimeline')}
                  maxChars={2000}
                  control={control}
                  disabled={busy !== null}
                  minHeight={96}
                />
              )}
            </Field>
            <Field
              label="Terms and conditions"
              optional
              hint="The conditions that apply to this quotation."
              error={errors['termsAndConditions']}
            >
              {(control) => (
                <TermsField
                  kind="terms_conditions"
                  presets={termPresets}
                  canAddTerms={canAddTerms}
                  value={values.termsAndConditions}
                  onChange={set('termsAndConditions')}
                  maxChars={10000}
                  control={control}
                  disabled={busy !== null}
                  minHeight={160}
                />
              )}
            </Field>
          </div>
        </Panel>

        <ApprovalPanel
          state={view.state}
          preview={readyPreview}
          message={view.message}
          approver={approver}
          onApproverChange={setApprover}
        />
      </fieldset>
    </div>
  );
}
