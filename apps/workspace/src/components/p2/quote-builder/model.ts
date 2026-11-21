// Pure rules shared by the client, server actions and tests. Milestone amounts depend on the
// server's final total. Pricing itself stays on the server.
import {
  formatPaymentPercentUnits,
  FULL_PAYMENT_PERCENT_UNITS,
  NonNegativeDecimalString,
  PaymentMilestoneSchema,
  paymentPercentUnits,
  trimPercent,
} from '@bos/contracts';
import { allocatePaymentSchedule, Dec, plainAmount, roundPaymentShare } from '@bos/locale';
import { z } from 'zod';

export type Currency = 'NPR' | 'INR' | 'USD';

/** "Choose NPR or USD." for the currencies the company has switched on (D44). */
export function currencyChoiceText(enabled: readonly string[]): string {
  const list =
    enabled.length < 2
      ? (enabled[0] ?? 'NPR')
      : `${enabled.slice(0, -1).join(', ')} or ${enabled.at(-1)}`;
  return `Choose ${list}.`;
}

/**
 * Why the builder cannot save `currency`, or null when it can: it must be switched on for the company,
 * or be the saved quotation's own currency (`kept`), which the API still accepts after it is switched off.
 */
export function currencyProblem(
  currency: string,
  enabled: readonly string[],
  kept?: string,
): string | null {
  if (enabled.includes(currency) || (kept !== undefined && currency === kept)) return null;
  return `${currency} is not enabled for your company. ${currencyChoiceText(enabled)}`;
}

export type DiscountMode = 'none' | 'pct' | 'amount';

export interface LineValues {
  /** Local identity for React keys and focus; never sent. */
  key: string;
  description: string;
  uom: string;
  quantity: string;
  unitPrice: string;
  taxCodeId: string;
  /**
   * Hidden: the builder never shows or edits these, but the API replaces lines wholesale on save,
   * so they travel with the line or a saved cost (and the margin from it) is erased. A new line
   * has both null. For a viewer without `quotation.cost.read` the API leaves `unitCost` out of the
   * line (D29): it is held as null and not sent, and the server keeps the stored cost itself.
   */
  unitCost?: string | null;
  catalogItemId?: string | null;
}

export interface MilestoneValues {
  key: string;
  label: string;
  percent: string;
  dueDescription: string;
}

export interface BuilderValues {
  contactId: string;
  currency: Currency;
  issueDate: string;
  validUntil: string;
  paymentTermId: string;
  scope: string;
  assumptions: string;
  exclusions: string;
  termsAndConditions: string;
  deliveryTimeline: string;
  discountMode: DiscountMode;
  discountValue: string;
  lines: LineValues[];
  schedule: MilestoneValues[];
}

/** The 12% rule of the approval workflow, as a display hint only; the server decides the route. */
export const DISCOUNT_APPROVAL_THRESHOLD_PCT = '12';

export function emptyValues(
  init: { currency?: Currency; issueDate?: string; validUntil?: string } = {},
): BuilderValues {
  return {
    contactId: '',
    currency: init.currency ?? 'NPR',
    issueDate: init.issueDate ?? '',
    validUntil: init.validUntil ?? '',
    paymentTermId: '',
    scope: '',
    assumptions: '',
    exclusions: '',
    termsAndConditions: '',
    deliveryTimeline: '',
    discountMode: 'none',
    discountValue: '',
    lines: [],
    schedule: [],
  };
}

export const newLine = (key: string): LineValues => ({
  key,
  description: '',
  uom: '',
  quantity: '1',
  unitPrice: '',
  taxCodeId: '',
  unitCost: null,
  catalogItemId: null,
});

export const newMilestone = (key: string): MilestoneValues => ({
  key,
  label: '',
  percent: '',
  dueDescription: '',
});

/** People type 12,50,000.00 in Nepal; the contract wants plain digits, so drop grouping and spaces. */
export function plainNumber(raw: string): string {
  return plainAmount(raw);
}

// ---------------------------------------------------------------------------------------------
// Payment schedule: must total exactly 100%
// ---------------------------------------------------------------------------------------------

const FULL_PERCENT = 100;

/** Number inputs can produce ".5"; the wire contract expects a leading digit. */
const milestoneNumber = (raw: string): string => plainNumber(raw).replace(/^\./, '0.');

function validPercent(raw: string): string | null {
  const value = PaymentMilestoneSchema.shape.percent.safeParse(milestoneNumber(raw));
  return value.success ? value.data : null;
}

function parseMilestoneMoney(raw: string): Dec | null {
  const value = NonNegativeDecimalString.safeParse(milestoneNumber(raw));
  return value.success ? new Dec(value.data) : null;
}

function percentUnits(percent: string): number | null {
  const valid = validPercent(percent);
  return valid === null ? null : paymentPercentUnits(valid);
}

function amountForPercent(percent: string, total: Dec): string {
  return roundPaymentShare(total, percent).toFixed(2);
}

/** Derive a row amount from the canonical percent and the current server-priced total. */
export function milestoneAmount(percent: string, total: string | null): string | null {
  const valid = validPercent(percent);
  const pricedTotal = total === null ? null : parseMilestoneMoney(total);
  return valid === null || pricedTotal === null ? null : amountForPercent(valid, pricedTotal);
}

/** Use final allocations for a complete schedule and independent estimates while editing. */
export function milestoneAmounts(
  milestones: readonly Pick<MilestoneValues, 'percent'>[],
  total: string | null,
): (string | null)[] {
  const pricedTotal = total === null ? null : parseMilestoneMoney(total);
  if (pricedTotal === null || scheduleState(milestones).kind !== 'ok') {
    return milestones.map(({ percent }) => milestoneAmount(percent, total));
  }
  return allocatePaymentSchedule(
    pricedTotal,
    milestones.map(({ percent }) => milestoneNumber(percent)),
  ).map((amount) => amount.toFixed(2));
}

export type MilestoneEdit = { field: 'percent' | 'amount'; value: string };

type MilestoneReconciliation =
  | { ok: true; percent: string; amount: string | null }
  | {
      ok: false;
      reason: 'invalid-percent' | 'invalid-amount' | 'total-unavailable' | 'above-total';
    };

/**
 * Resolve a user edit to the percent we can persist and the amount it represents.
 * Pass null while the server total is absent or stale.
 */
export function reconcileMilestone(
  currentPercent: string,
  edit: MilestoneEdit,
  total: string | null,
): MilestoneReconciliation {
  if (edit.field === 'percent') {
    const percent = validPercent(edit.value);
    return percent === null
      ? { ok: false, reason: 'invalid-percent' }
      : { ok: true, percent, amount: milestoneAmount(percent, total) };
  }

  const amount = parseMilestoneMoney(edit.value);
  if (amount === null) return { ok: false, reason: 'invalid-amount' };
  const pricedTotal = total === null ? null : parseMilestoneMoney(total);
  if (pricedTotal === null) return { ok: false, reason: 'total-unavailable' };
  if (amount.gt(pricedTotal)) return { ok: false, reason: 'above-total' };
  // Every valid percent represents zero money on a zero total. Keep the user's allocation.
  if (pricedTotal.isZero()) {
    const percent = validPercent(currentPercent);
    return percent === null
      ? { ok: false, reason: 'invalid-percent' }
      : { ok: true, percent, amount: '0.00' };
  }

  const percent = trimPercent(amount.times(FULL_PERCENT).div(pricedTotal).toFixed(4));
  return { ok: true, percent, amount: amountForPercent(percent, pricedTotal) };
}

export type ScheduleState =
  | { kind: 'empty' }
  | { kind: 'ok' }
  | { kind: 'short'; by: string }
  | { kind: 'over'; by: string }
  | { kind: 'invalid' };

/** The running total of valid entries, even while another row is incomplete. */
export function scheduleProgress(milestones: readonly Pick<MilestoneValues, 'percent'>[]): string {
  return formatPaymentPercentUnits(
    milestones.reduce((sum, m) => sum + (percentUnits(m.percent) ?? 0), 0),
  );
}

/** An empty schedule is allowed (the payment term applies); a filled one must total 100%. */
export function scheduleState(
  milestones: readonly Pick<MilestoneValues, 'percent'>[],
): ScheduleState {
  if (milestones.length === 0) return { kind: 'empty' };
  let sum = 0;
  for (const m of milestones) {
    const units = percentUnits(m.percent);
    if (units === null) return { kind: 'invalid' };
    sum += units;
  }
  if (sum === FULL_PAYMENT_PERCENT_UNITS) return { kind: 'ok' };
  return sum < FULL_PAYMENT_PERCENT_UNITS
    ? { kind: 'short', by: formatPaymentPercentUnits(FULL_PAYMENT_PERCENT_UNITS - sum) }
    : { kind: 'over', by: formatPaymentPercentUnits(sum - FULL_PAYMENT_PERCENT_UNITS) };
}

export function scheduleMessage(state: ScheduleState): string | null {
  switch (state.kind) {
    case 'short':
      return `The payment schedule must add up to 100%. It is ${state.by}% short.`;
    case 'over':
      return `The payment schedule must add up to 100%. It is ${state.by}% over.`;
    case 'invalid':
      return 'Enter each milestone as a percentage from 0 to 100 with up to four decimal places.';
    default:
      return null;
  }
}

const dueDateSchema = z.iso.date();

export function milestoneDue(
  dueDescription: string,
): { kind: 'empty' } | { kind: 'date'; date: string } | { kind: 'legacy'; description: string } {
  if (dueDescription === '') return { kind: 'empty' };
  if (dueDateSchema.safeParse(dueDescription).success)
    return { kind: 'date', date: dueDescription };
  return { kind: 'legacy', description: dueDescription };
}

/** Store a Gregorian date in the existing description slot and protect existing free text. */
export function setMilestoneDueDate(
  dueDescription: string,
  date: string,
):
  | { ok: true; dueDescription: string }
  | { ok: false; reason: 'legacy-description' | 'invalid-date' } {
  if (milestoneDue(dueDescription).kind === 'legacy') {
    return { ok: false, reason: 'legacy-description' };
  }
  if (date !== '' && !dueDateSchema.safeParse(date).success) {
    return { ok: false, reason: 'invalid-date' };
  }
  return { ok: true, dueDescription: date };
}

/** Why Submit is unavailable, in words; null when it may go. */
export function submitBlocker(values: BuilderValues, opts: { dirty: boolean }): string | null {
  const schedule = scheduleMessage(scheduleState(values.schedule));
  if (schedule) return schedule;
  if (values.lines.length === 0) return 'Add at least one line before submitting.';
  if (opts.dirty) return 'Save the draft before submitting, so the approvers see what you see.';
  return null;
}

// ---------------------------------------------------------------------------------------------
// Discount trigger (display only)
// ---------------------------------------------------------------------------------------------

/** `pct` is the server's 4-decimal string. True only when it is strictly above 12, exactly. */
export function discountAboveThreshold(pct: string): boolean {
  const [whole = '0', frac = ''] = pct.split('.');
  const w = Number(whole);
  const threshold = Number(DISCOUNT_APPROVAL_THRESHOLD_PCT);
  if (w !== threshold) return w > threshold;
  return /[1-9]/.test(frac);
}

// ---------------------------------------------------------------------------------------------
// To and from the contract
// ---------------------------------------------------------------------------------------------

/**
 * The editable content in the shape of `QuotationVersionContentSchema`; the server action parses it.
 * A create leaves a blank optional field out. An update sends `null` for it instead: the PUT keeps
 * any key it is not sent, so leaving it out would keep the saved value and a cleared field would
 * come back on reload.
 */
export function toContent(v: BuilderValues, mode: 'create' | 'update' = 'create') {
  const opt = (s: string): string | undefined => (s.trim() === '' ? undefined : s.trim());
  const blank = mode === 'update' ? null : undefined;
  const discount =
    v.discountMode === 'none' || plainNumber(v.discountValue) === ''
      ? undefined
      : ({ mode: v.discountMode, value: plainNumber(v.discountValue) } as const);
  const content = {
    contactId: opt(v.contactId) ?? blank,
    currency: v.currency,
    issueDate: v.issueDate,
    validUntil: v.validUntil,
    scope: opt(v.scope) ?? blank,
    assumptions: opt(v.assumptions) ?? blank,
    exclusions: opt(v.exclusions) ?? blank,
    termsAndConditions: opt(v.termsAndConditions) ?? blank,
    deliveryTimeline: opt(v.deliveryTimeline) ?? blank,
    paymentTermId: opt(v.paymentTermId) ?? blank,
    paymentSchedule:
      v.schedule.length > 0
        ? v.schedule.map((m) => ({
            label: m.label.trim(),
            percent: milestoneNumber(m.percent),
            ...(opt(m.dueDescription) ? { dueDescription: m.dueDescription.trim() } : {}),
          }))
        : blank,
    discount: discount ?? blank,
    lines: v.lines.map((l) => ({
      description: l.description.trim(),
      uom: l.uom.trim(),
      quantity: plainNumber(l.quantity),
      unitPrice: plainNumber(l.unitPrice),
      taxCodeId: l.taxCodeId,
      // The contract takes these as optional, not null: a line without them sends neither key.
      ...(l.unitCost ? { unitCost: l.unitCost } : {}),
      ...(l.catalogItemId ? { catalogItemId: l.catalogItemId } : {}),
    })),
  };
  // Leave absent keys out entirely (not as `undefined`), so the body says only what it means.
  return Object.fromEntries(Object.entries(content).filter(([, x]) => x !== undefined)) as Partial<
    typeof content
  > &
    Pick<typeof content, 'currency' | 'issueDate' | 'validUntil' | 'lines'>;
}

/** The slice of a version DTO the form is filled from (structural, so no runtime import). */
export interface VersionLike {
  contactId: string | null;
  currency: Currency;
  issueDate: string;
  validUntil: string;
  paymentTermId: string | null;
  scope: string | null;
  assumptions: string | null;
  exclusions: string | null;
  termsAndConditions: string | null;
  deliveryTimeline: string | null;
  discount: { mode: 'pct' | 'amount'; value: string } | null;
  lines: readonly {
    description: string;
    uom: string;
    quantity: string;
    unitPrice: string;
    taxCodeId: string;
    unitCost?: string | null | undefined;
    catalogItemId?: string | null | undefined;
  }[];
  paymentSchedule: readonly {
    label: string;
    percent: string;
    dueDescription?: string | undefined;
  }[];
}

export function valuesFromVersion(d: VersionLike): BuilderValues {
  return {
    contactId: d.contactId ?? '',
    currency: d.currency,
    issueDate: d.issueDate,
    validUntil: d.validUntil,
    paymentTermId: d.paymentTermId ?? '',
    scope: d.scope ?? '',
    assumptions: d.assumptions ?? '',
    exclusions: d.exclusions ?? '',
    termsAndConditions: d.termsAndConditions ?? '',
    deliveryTimeline: d.deliveryTimeline ?? '',
    discountMode: d.discount?.mode ?? 'none',
    discountValue: d.discount?.value ?? '',
    lines: d.lines.map((l, i) => ({
      key: `l${i + 1}`,
      description: l.description,
      uom: l.uom,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      taxCodeId: l.taxCodeId,
      unitCost: l.unitCost ?? null,
      catalogItemId: l.catalogItemId ?? null,
    })),
    schedule: d.paymentSchedule.map((m, i) => ({
      key: `m${i + 1}`,
      label: m.label,
      percent: trimPercent(m.percent),
      dueDescription: m.dueDescription ?? '',
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Defaults for a new quotation
// ---------------------------------------------------------------------------------------------

/** Issue date today in Kathmandu and a 30-day validity, both as ISO dates (`YYYY-MM-DD`). */
export function defaultDates(now: Date = new Date()): { issueDate: string; validUntil: string } {
  const issueDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kathmandu',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [y = 1970, m = 1, d = 1] = issueDate.split('-').map(Number);
  const until = new Date(Date.UTC(y, m - 1, d + 30)).toISOString().slice(0, 10);
  return { issueDate, validUntil: until };
}
