import 'server-only';

import {
  EVIDENCE_POLICIES,
  SETTING_DEFAULTS,
  type EvidencePolicy,
  type LeadOwnerOption,
  type SettingKey,
} from '@bos/contracts';

import { defaultText, isDefaultValue } from '@/components/settings/default-value';
import { getSetting, type SettingCurrent } from '@/lib/api-admin';
import type { Session } from '@/lib/session';

import { section, type Section } from '../section';
import { SETTING_COPY, toFieldValue, type FieldKind, type FieldSpec } from './setting-fields';

const EVIDENCE_LABEL: Record<EvidencePolicy, string> = {
  signed_quote: 'Signed quotation',
  contract: 'Contract',
  purchase_order: 'Purchase order',
  both: 'Contract and purchase order',
};

/** The default in the screen's own words: a select shows its option's label, not the stored value. */
function defaultLabel(key: SettingKey, kind: FieldKind): string {
  if (kind === 'person') return 'Sales head';
  if (kind === 'select') {
    const stored = SETTING_DEFAULTS[key];
    if (typeof stored === 'string' && Object.hasOwn(EVIDENCE_LABEL, stored)) {
      return EVIDENCE_LABEL[stored as EvidencePolicy];
    }
  }
  return defaultText(key);
}

type Option = { value: string; label: string };

/**
 * The people a `person` field offers, named as the lead owner select names them (`ownerOptionName`). A saved person
 * the list no longer holds stays selectable under a plain label, so the field never shows the Sales head while the
 * stored value names someone else; the API hands such leads to the Sales head.
 */
function personOptions(people: readonly LeadOwnerOption[], saved: unknown): Option[] {
  const options = people.map((p) => ({
    value: p.userId,
    label: p.displayName || p.email || 'Unnamed user',
  }));
  if (typeof saved === 'string' && saved !== '' && !options.some((o) => o.value === saved)) {
    options.push({ value: saved, label: 'Unavailable person (Sales head is used)' });
  }
  return options;
}

function optionsFor(
  kind: FieldKind,
  saved: unknown,
  people: readonly LeadOwnerOption[],
): Option[] | undefined {
  if (kind === 'select') {
    return EVIDENCE_POLICIES.map((value) => ({ value, label: EVIDENCE_LABEL[value] }));
  }
  if (kind === 'person') return personOptions(people, saved);
  return undefined;
}

function toSpec(
  key: SettingKey,
  current: SettingCurrent,
  people: readonly LeadOwnerOption[],
): FieldSpec {
  const copy = SETTING_COPY[key];
  if (copy === undefined) throw new Error(`No settings copy for ${key}`);
  const options = optionsFor(copy.kind, current.value, people);
  return {
    key,
    label: copy.label,
    ...(copy.help ? { help: copy.help } : {}),
    kind: copy.kind,
    current: toFieldValue(copy.kind, current.value),
    defaultValue: toFieldValue(copy.kind, SETTING_DEFAULTS[key]),
    version: current.version,
    defaultText: defaultLabel(key, copy.kind),
    isDefault: isDefaultValue(key, current.value),
    ...(copy.numberBounds ? { numberBounds: copy.numberBounds } : {}),
    ...(options ? { options } : {}),
  };
}

/**
 * Load the current values for one card. One failed read (for example a 403) gives one notice. A card with a
 * `person` field passes `people`, the list to pick from; it is read inside the same notice, so a refused list costs
 * only that card.
 */
export async function loadFields(
  session: Session,
  keys: readonly SettingKey[],
  people?: () => Promise<readonly LeadOwnerOption[]>,
): Promise<Section<FieldSpec[]>> {
  return section('view these settings', async () => {
    const [list, currents] = await Promise.all([
      people ? people() : Promise.resolve([]),
      Promise.all(keys.map((key) => getSetting(session, key))),
    ]);
    return keys.map((key, i) => toSpec(key, currents[i]!, list));
  });
}
