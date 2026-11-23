import 'server-only';

import {
  EVIDENCE_POLICIES,
  SETTING_DEFAULTS,
  type EvidencePolicy,
  type SettingKey,
  type SettingsPerson,
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
 * The people a `person` field offers, by name and role as the API sends them, and the Sales head an unset value
 * stands for. A saved person the list no longer holds stays in the box under a plain label, so the field never shows
 * the Sales head while the stored value names someone else; the API hands such leads to the Sales head.
 */
function personFields(
  people: readonly SettingsPerson[],
  saved: unknown,
): Pick<FieldSpec, 'people' | 'salesHeadId' | 'unavailablePerson'> {
  const head = people.find((p) => p.salesHead === true);
  return {
    people: people.map((p) => ({
      id: p.userId,
      name: p.displayName || 'Unnamed user',
      role: p.role ?? null,
    })),
    ...(head ? { salesHeadId: head.userId } : {}),
    ...(typeof saved === 'string' && saved !== '' && !people.some((p) => p.userId === saved)
      ? { unavailablePerson: { id: saved, name: 'Unavailable person (Sales head is used)' } }
      : {}),
  };
}

function optionsFor(kind: FieldKind): Option[] | undefined {
  if (kind === 'select') {
    return EVIDENCE_POLICIES.map((value) => ({ value, label: EVIDENCE_LABEL[value] }));
  }
  return undefined;
}

function toSpec(
  key: SettingKey,
  current: SettingCurrent,
  people: readonly SettingsPerson[],
): FieldSpec {
  const copy = SETTING_COPY[key];
  if (copy === undefined) throw new Error(`No settings copy for ${key}`);
  const options = optionsFor(copy.kind);
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
    ...(copy.kind === 'person' ? personFields(people, current.value) : {}),
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
  people?: () => Promise<readonly SettingsPerson[]>,
): Promise<Section<FieldSpec[]>> {
  return section('view these settings', async () => {
    const [list, currents] = await Promise.all([
      people ? people() : Promise.resolve([]),
      Promise.all(keys.map((key) => getSetting(session, key))),
    ]);
    return keys.map((key, i) => toSpec(key, currents[i]!, list));
  });
}
