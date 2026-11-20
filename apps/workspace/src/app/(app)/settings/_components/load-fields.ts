import 'server-only';

import {
  EVIDENCE_POLICIES,
  SETTING_DEFAULTS,
  type EvidencePolicy,
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
  if (kind === 'select') {
    const stored = SETTING_DEFAULTS[key];
    if (typeof stored === 'string' && Object.hasOwn(EVIDENCE_LABEL, stored)) {
      return EVIDENCE_LABEL[stored as EvidencePolicy];
    }
  }
  return defaultText(key);
}

function toSpec(key: SettingKey, current: SettingCurrent): FieldSpec {
  const copy = SETTING_COPY[key];
  if (copy === undefined) throw new Error(`No settings copy for ${key}`);
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
