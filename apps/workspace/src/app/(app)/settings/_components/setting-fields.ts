// Typed model and copy for settings values cards: plain data (no 'use server', no 'server-only'),
// so Server Components, Server Actions and Client Components share one source of truth without
// passing JSON strings through form controls.
import {
  CURRENCIES,
  CurrencySchema,
  DEFAULT_SALES_SCHEDULE,
  FULL_PAYMENT_PERCENT_UNITS,
  PercentFourDecimals,
  RoleKeySchema,
  SCHEDULE_TRIGGERS,
  SETTING_DEFAULTS,
  ScheduleTemplateSchema,
  ScheduleTriggerSchema,
  SlaSpecSchema,
  formatPaymentPercentUnits,
  paymentPercentUnits,
  type Currency,
  type RoleKey,
  type ScheduleTrigger,
  type SettingKey,
} from '@bos/contracts';

import type { MemberOption } from '@/components/ui/member-picker';

export type FieldKind =
  | 'integer'
  | 'percent'
  | 'money'
  | 'prefix'
  | 'select'
  | 'person'
  | 'currencies'
  | 'sla'
  | 'schedule';

export interface SlaFieldValue {
  remindAfterHours: string;
  escalateAfterHours: string;
  escalateToRole: RoleKey;
}

export interface ScheduleRowValue {
  label: string;
  percent: string;
  trigger: ScheduleTrigger;
}

export type SettingFieldValue =
  | { kind: 'text'; value: string }
  | { kind: 'currencies'; values: readonly Currency[] }
  | { kind: 'sla'; value: SlaFieldValue }
  | { kind: 'schedule'; rows: readonly ScheduleRowValue[] };

export interface NumberBounds {
  min?: number;
  max?: number;
  step: string;
}

export interface FieldSpec {
  key: SettingKey;
  label: string;
  help?: string;
  kind: FieldKind;
  /** Typed saved value currently stored (or built-in default when version is null). */
  current: SettingFieldValue;
  /** Typed built-in default from SETTING_DEFAULTS, so Reset to default stages it in the form. */
  defaultValue: SettingFieldValue;
  /** The version this screen loaded, or null when nobody has saved the key yet. */
  version: number | null;
  /** The default (D32) as short text for the reset tooltip: `13`, `NPR, INR, USD`, an option's label. */
  defaultText: string;
  /** True when the saved value already equals the default. */
  isDefault: boolean;
  /** Number input constraints derived from the contract schema (UIP-FORM-004). */
  numberBounds?: NumberBounds;
  /** For `select`. */
  options?: readonly { value: string; label: string }[];
  /** For `person`: who can be chosen, by name and role (the one member picker, BOS-UI-001). */
  people?: readonly MemberOption[];
  /**
   * For `person`: the Sales head, who an empty value stands for (saving none stores null, so the Sales head owns such
   * leads). The picker shows this person, never a placeholder phrase. Absent when the entity has no Sales head.
   */
  salesHeadId?: string;
  /** For `person`: the saved person the list no longer holds, kept in the box by a plain name. */
  unavailablePerson?: { id: string; name: string };
}

/** Human labels for the contract's SCHEDULE_TRIGGERS enum. Typed so adding a trigger fails to compile until labelled. */
export const TRIGGER_LABEL: Record<ScheduleTrigger, string> = {
  advance: 'Advance',
  milestone: 'Milestone',
  uat: 'After acceptance',
  delivery: 'On delivery',
  date: 'On a date',
  manual: 'Manual',
};

export const TRIGGER_OPTIONS: readonly { value: ScheduleTrigger; label: string }[] =
  SCHEDULE_TRIGGERS.map((value) => ({ value, label: TRIGGER_LABEL[value] }));

export interface SettingCopyEntry {
  label: string;
  help?: string;
  kind: FieldKind;
  numberBounds?: NumberBounds;
}

// The words, control kind and numeric limits for each card setting. Never a raw key or version number.
export const SETTING_COPY: Partial<Record<SettingKey, SettingCopyEntry>> = {
  'currency.enabled': {
    label: 'Currencies in use',
    help: 'Currencies a document may use. NPR is the books currency and stays on.',
    kind: 'currencies',
  },
  'fx.max_rate_age_days': {
    label: 'Oldest exchange rate allowed (days)',
    help: 'A document in USD or INR is refused when the newest rate is older than this. A whole number from 1 to 365.',
    kind: 'integer',
    numberBounds: { min: 1, max: 365, step: '1' },
  },
  'tax.vat_rate': {
    label: 'Default VAT rate',
    help: 'Enter 0 to 100 with up to two decimal places.',
    kind: 'percent',
    numberBounds: { min: 0, max: 100, step: '0.01' },
  },
  'numbering.memo_prefix': {
    label: 'Memo number prefix',
    help: 'Two to ten capitals or digits, as in MEMO-2082/83-00001.',
    kind: 'prefix',
  },
  'quotation.validity_days': {
    label: 'Quotation validity (days)',
    help: 'How long a sent quotation stays valid when its author sets no expiry date. A whole number from 1 to 365.',
    kind: 'integer',
    numberBounds: { min: 1, max: 365, step: '1' },
  },
  'sales.evidence_policy': {
    label: 'Evidence before an opportunity is won',
    help: 'What must be on file for an accepted quotation.',
    kind: 'select',
  },
  'sales.default_schedule': {
    label: 'Default billing schedule',
    help: 'Billing slices used when an accepted quotation has no payment schedule. The percentages must add up to 100.',
    kind: 'schedule',
  },
  'sales.delivery_hold.management_npr': {
    label: 'Management releases holds above (NPR)',
    help: 'Finance releases a held delivery worth up to and including this amount. Above it, only Management or the Founder can.',
    kind: 'money',
    numberBounds: { min: 0, step: '0.01' },
  },
  'crm.default_lead_owner': {
    label: 'Default owner',
    help: 'New leads that have no owner of their own, such as website leads, go to this person.',
    kind: 'person',
  },
  'approvals.sla_defaults': {
    label: 'Default reminder and escalation times',
    help: 'Used by a workflow that does not set its own times.',
    kind: 'sla',
  },
  'procurement.min_quotes': {
    label: 'Quotes needed before a recommendation',
    help: 'Fewer needs a written reason. A whole number from 1 to 10.',
    kind: 'integer',
    numberBounds: { min: 1, max: 10, step: '1' },
  },
  'procurement.match.qty_pct': {
    label: 'Quantity tolerance',
    help: 'How far above the purchase order quantity a bill line may go. 0 means none.',
    kind: 'percent',
    numberBounds: { min: 0, max: 100, step: '0.01' },
  },
  'procurement.match.price_pct': {
    label: 'Price tolerance',
    help: 'How far a bill line price may differ from the purchase order price. The lower of this and the NPR figure applies.',
    kind: 'percent',
    numberBounds: { min: 0, max: 100, step: '0.01' },
  },
  'procurement.match.price_npr': {
    label: 'Price tolerance (NPR)',
    help: 'The same, in rupees. The lower of this and the percentage applies.',
    kind: 'money',
    numberBounds: { min: 0, step: '0.01' },
  },
  'procurement.band.management_npr': {
    label: 'Management approval above (NPR)',
    help: 'A purchase commitment or payment above this total needs a Management step.',
    kind: 'money',
    numberBounds: { min: 0, step: '0.01' },
  },
  'procurement.band.founder_npr': {
    label: 'Founder approval above (NPR)',
    help: 'Above this total a Founder step is added too.',
    kind: 'money',
    numberBounds: { min: 0, step: '0.01' },
  },
};

export function settingLabel(key: SettingKey): string {
  return SETTING_COPY[key]?.label ?? key;
}

export function settingKind(key: SettingKey): FieldKind {
  return SETTING_COPY[key]?.kind ?? 'prefix';
}

function normaliseCurrencies(value: unknown): Currency[] {
  const picked = new Set<Currency>(['NPR']);
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = CurrencySchema.safeParse(item);
      if (parsed.success) picked.add(parsed.data);
    }
  }
  return CURRENCIES.filter((c) => picked.has(c));
}

function toSlaFieldValue(value: unknown): SlaFieldValue {
  const parsed = SlaSpecSchema.safeParse(value);
  if (parsed.success) {
    return {
      remindAfterHours: String(parsed.data.remindAfterHours),
      escalateAfterHours: String(parsed.data.escalateAfterHours),
      escalateToRole: parsed.data.escalateTo.role,
    };
  }
  const fallback = SETTING_DEFAULTS['approvals.sla_defaults'];
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const escalateTo =
    typeof raw.escalateTo === 'object' && raw.escalateTo !== null
      ? (raw.escalateTo as Record<string, unknown>)
      : {};
  const roleParsed = RoleKeySchema.safeParse(escalateTo.role);
  return {
    remindAfterHours:
      typeof raw.remindAfterHours === 'number' || typeof raw.remindAfterHours === 'string'
        ? String(raw.remindAfterHours)
        : String(fallback.remindAfterHours),
    escalateAfterHours:
      typeof raw.escalateAfterHours === 'number' || typeof raw.escalateAfterHours === 'string'
        ? String(raw.escalateAfterHours)
        : String(fallback.escalateAfterHours),
    escalateToRole: roleParsed.success ? roleParsed.data : fallback.escalateTo.role,
  };
}

function toScheduleRows(value: unknown): ScheduleRowValue[] {
  const parsed = ScheduleTemplateSchema.safeParse(value);
  if (parsed.success) {
    return parsed.data.map((row) => ({
      label: row.label,
      percent: row.percent,
      trigger: row.trigger,
    }));
  }
  if (Array.isArray(value) && value.length > 0) {
    return value.map((item) => {
      const row =
        typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
      const triggerParsed = ScheduleTriggerSchema.safeParse(row.trigger);
      return {
        label: typeof row.label === 'string' ? row.label : '',
        percent:
          typeof row.percent === 'string' || typeof row.percent === 'number'
            ? String(row.percent)
            : '',
        trigger: triggerParsed.success ? triggerParsed.data : 'milestone',
      };
    });
  }
  return DEFAULT_SALES_SCHEDULE.map((row) => ({
    label: row.label,
    percent: row.percent,
    trigger: row.trigger,
  }));
}

/** Converts a stored setting value into its typed client field representation (no JSON strings). */
export function toFieldValue(kind: FieldKind, value: unknown): SettingFieldValue {
  switch (kind) {
    case 'currencies':
      return { kind: 'currencies', values: normaliseCurrencies(value) };
    case 'sla':
      return { kind: 'sla', value: toSlaFieldValue(value) };
    case 'schedule':
      return { kind: 'schedule', rows: toScheduleRows(value) };
    case 'integer':
    case 'percent':
    case 'money':
    case 'prefix':
    case 'select':
    case 'person': {
      if (value === null || value === undefined) return { kind: 'text', value: '' };
      if (typeof value === 'string') return { kind: 'text', value };
      if (typeof value === 'number') return { kind: 'text', value: String(value) };
      return { kind: 'text', value: '' };
    }
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/** True when two typed field drafts hold the exact same user input. Currencies are compared as a set. */
export function sameFieldValue(a: SettingFieldValue, b: SettingFieldValue): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'text':
      return b.kind === 'text' && a.value === b.value;
    case 'currencies': {
      if (b.kind !== 'currencies') return false;
      const setA = new Set(a.values);
      const setB = new Set(b.values);
      if (setA.size !== setB.size) return false;
      for (const item of setA) {
        if (!setB.has(item)) return false;
      }
      return true;
    }
    case 'sla':
      return (
        b.kind === 'sla' &&
        a.value.remindAfterHours === b.value.remindAfterHours &&
        a.value.escalateAfterHours === b.value.escalateAfterHours &&
        a.value.escalateToRole === b.value.escalateToRole
      );
    case 'schedule':
      return (
        b.kind === 'schedule' &&
        a.rows.length === b.rows.length &&
        a.rows.every((row, i) => {
          const other = b.rows[i];
          return (
            other !== undefined &&
            row.label === other.label &&
            row.percent === other.percent &&
            row.trigger === other.trigger
          );
        })
      );
    default: {
      const _exhaustive: never = a;
      return _exhaustive;
    }
  }
}

export type ScheduleSummary =
  | { status: 'ok'; totalText: '100' }
  | { status: 'short'; totalText: string; diffText: string; actionText: string }
  | { status: 'over'; totalText: string; diffText: string; actionText: string }
  | { status: 'invalid'; totalText: string; invalidIndices: number[] };

/** Exact integer percentage sum for a billing schedule, with inline shortfall wording. */
export function scheduleSummary(rows: readonly ScheduleRowValue[]): ScheduleSummary {
  let units = 0;
  const invalidIndices: number[] = [];
  rows.forEach((row, index) => {
    const trimmed = row.percent.trim();
    if (PercentFourDecimals.safeParse(trimmed).success) {
      units += paymentPercentUnits(trimmed);
    } else {
      invalidIndices.push(index);
    }
  });
  const totalText = formatPaymentPercentUnits(units);
  if (invalidIndices.length > 0) {
    return { status: 'invalid', totalText, invalidIndices };
  }
  if (units === FULL_PAYMENT_PERCENT_UNITS) {
    return { status: 'ok', totalText: '100' };
  }
  if (units < FULL_PAYMENT_PERCENT_UNITS) {
    const diffText = formatPaymentPercentUnits(FULL_PAYMENT_PERCENT_UNITS - units);
    return { status: 'short', totalText, diffText, actionText: `Add ${diffText}% more` };
  }
  const diffText = formatPaymentPercentUnits(units - FULL_PAYMENT_PERCENT_UNITS);
  return { status: 'over', totalText, diffText, actionText: `Remove ${diffText}%` };
}
