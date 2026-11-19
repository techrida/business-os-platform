import 'server-only';

import { EVIDENCE_POLICIES, type EvidencePolicy, type SettingKey } from '@bos/contracts';

import { getSetting, type SettingCurrent } from '@/lib/api-admin';
import type { Session } from '@/lib/session';

import { section, type Section } from '../section';
import type { FieldKind, FieldSpec } from './setting-fields';
import { settingValueText } from './setting-input';

const EVIDENCE_LABEL: Record<EvidencePolicy, string> = {
  signed_quote: 'Signed quotation',
  contract: 'Contract',
  purchase_order: 'Purchase order',
  both: 'Contract and purchase order',
};

interface Copy {
  label: string;
  help?: string;
  kind: FieldKind;
}

// The words and control for each setting. Never a raw key and never a version number: the person
// sees what they are deciding, not how it is stored.
const COPY: Partial<Record<SettingKey, Copy>> = {
  'currency.enabled': {
    label: 'Currencies in use',
    help: 'Currencies a document may use. NPR is the books currency and stays on.',
    kind: 'currencies',
  },
  'fx.max_rate_age_days': {
    label: 'Oldest exchange rate allowed (days)',
    help: 'A document in USD or INR is refused when the newest rate is older than this. A whole number from 1 to 365.',
    kind: 'integer',
  },
  'tax.vat_rate': {
    label: 'Default VAT rate (%)',
    help: 'Enter 0 to 100 with up to two decimal places.',
    kind: 'percent',
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
  'approvals.sla_defaults': {
    label: 'Default reminder and escalation times',
    help: 'Used by a workflow that does not set its own times.',
    kind: 'sla',
  },
  'procurement.min_quotes': {
    label: 'Quotes needed before a recommendation',
    help: 'Fewer needs a written reason. A whole number from 1 to 10.',
    kind: 'integer',
  },
  'procurement.match.qty_pct': {
    label: 'Quantity tolerance (%)',
    help: 'How far above the purchase order quantity a bill line may go. 0 means none.',
    kind: 'percent',
  },
  'procurement.match.price_pct': {
    label: 'Price tolerance (%)',
    help: 'How far a bill line price may differ from the purchase order price. The lower of this and the NPR figure applies.',
    kind: 'percent',
  },
  'procurement.match.price_npr': {
    label: 'Price tolerance (NPR)',
    help: 'The same, in rupees. The lower of this and the percentage applies.',
    kind: 'money',
  },
  'procurement.band.management_npr': {
    label: 'Management approval above (NPR)',
    help: 'A purchase commitment or payment above this total needs a Management step.',
    kind: 'money',
  },
  'procurement.band.founder_npr': {
    label: 'Founder approval above (NPR)',
    help: 'Above this total a Founder step is added too.',
    kind: 'money',
  },
};

const compact = (value: unknown, kind: FieldKind): string =>
  kind === 'sla' || kind === 'schedule' ? JSON.stringify(value) : settingValueText(value);

function toSpec(key: SettingKey, current: SettingCurrent): FieldSpec {
  const copy = COPY[key];
  if (copy === undefined) throw new Error(`No settings copy for ${key}`);
  return {
    key,
    label: copy.label,
    ...(copy.help ? { help: copy.help } : {}),
    kind: copy.kind,
    current: compact(current.value, copy.kind),
    ...(copy.kind === 'select'
      ? {
          options: EVIDENCE_POLICIES.map((value) => ({ value, label: EVIDENCE_LABEL[value] })),
        }
      : {}),
  };
}

/** Load the current values for one card. One failed read (for example a 403) gives one notice. */
export async function loadFields(
  session: Session,
  keys: readonly SettingKey[],
): Promise<Section<FieldSpec[]>> {
  return section('view these settings', async () =>
    Promise.all(keys.map(async (key) => toSpec(key, await getSetting(session, key)))),
  );
}

/** Remounts a card after a save: its saved values are the new baseline. */
export const cardKey = (fields: readonly FieldSpec[]): string =>
  fields.map((f) => f.current).join('\u0000');
