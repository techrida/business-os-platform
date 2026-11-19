// What a settings card shows: plain data, so a Server page can build it and the client card can
// render it. `current` is the saved value as text (see `settingValueText`).
import type { SettingKey } from '@bos/contracts';

export type FieldKind =
  'integer' | 'percent' | 'money' | 'prefix' | 'select' | 'currencies' | 'sla' | 'schedule';

export interface FieldSpec {
  key: SettingKey;
  label: string;
  help?: string;
  kind: FieldKind;
  current: string;
  /** For `select`. */
  options?: readonly { value: string; label: string }[];
}
