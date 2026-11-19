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
  /** The default (D32) as short text for the reset tooltip: `13`, `NPR, INR, USD`, an option's label. */
  defaultText: string;
  /** True when the saved value already equals the default: the card then draws no reset button. */
  isDefault: boolean;
  /** For `select`. */
  options?: readonly { value: string; label: string }[];
}
