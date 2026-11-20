// Who may read and change which admin setting (F1-Q48). One place for the whole map, because one @Can names one
// permission and these routes accept any of several. The routes carry @AnyAuthenticated and call these checks
// before reading or writing anything.
//
// - FX rates: Finance (settings.fx_rate.write).
// - tax.*, numbering.*, the number series and the Terms page (term presets and the reset to the default term
//   sets, stored as quotation.term_presets): Finance and Accountant (settings.finance.write).
// - Everything else, including currency.enabled and fx.max_rate_age_days: admin.settings.write (the Founder).
// admin.settings.write is accepted everywhere.
import type { Permission, SettingKey } from '@bos/contracts';
import { ForbiddenException } from '@nestjs/common';

import { can } from '../authz/can';
import { principal } from '../authz/principal';

const ADMIN: Permission = 'admin.settings.write';

/** Who may read and add exchange rates. */
export const FX_RATE_EDITORS: readonly Permission[] = ['settings.fx_rate.write', ADMIN];

/** Who may change the finance keys, the number series and the Terms page. */
export const FINANCE_SETTINGS_EDITORS: readonly Permission[] = ['settings.finance.write', ADMIN];

/** Who may change every other setting. */
export const ADMIN_SETTINGS_EDITORS: readonly Permission[] = [ADMIN];

/** Key prefixes (ending in '.') and exact keys open to more than the admin. A key matching none is admin only. */
const KEY_PREFIX_EDITORS: ReadonlyArray<readonly [prefix: string, editors: readonly Permission[]]> = [
  ['tax.', FINANCE_SETTINGS_EDITORS],
  ['numbering.', FINANCE_SETTINGS_EDITORS],
];
const KEY_EDITORS: Readonly<Partial<Record<SettingKey, readonly Permission[]>>> = {
  'quotation.term_presets': FINANCE_SETTINGS_EDITORS,
};

/** Anyone who may edit at least one setting key through GET/PUT settings/:key. */
export const ANY_SETTING_EDITORS: readonly Permission[] = [
  ...new Set([...ADMIN_SETTINGS_EDITORS, ...FINANCE_SETTINGS_EDITORS]),
];

/** The permissions any one of which lets a caller read and change `key`. */
export function settingEditors(key: SettingKey): readonly Permission[] {
  const exact = KEY_EDITORS[key];
  if (exact) return exact;
  const byPrefix = KEY_PREFIX_EDITORS.find(([prefix]) => key.startsWith(prefix));
  return byPrefix ? byPrefix[1] : ADMIN_SETTINGS_EDITORS;
}

/** True when the current principal is active staff holding at least one of `actions`. */
export function holdsAnyOf(actions: readonly Permission[]): boolean {
  const caller = principal();
  if (caller.orgKind !== 'staff') return false;
  return actions.some((action) => can(caller, action).allowed);
}

/**
 * Returns when the current principal is active staff holding one of `actions`; else 403 with the same body
 * AuthzService.assert sends (`inactive_user` for an inactive caller, `no_permission` otherwise).
 */
export function assertAnyOf(actions: readonly Permission[]): void {
  if (holdsAnyOf(actions)) return;
  throw new ForbiddenException({
    code: 'forbidden',
    message: 'Forbidden',
    reason: principal().status === 'active' ? 'no_permission' : 'inactive_user',
  });
}
