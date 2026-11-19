import type { NumberSystem } from '@bos/locale';

import { money } from '@/lib/kernel-format';

/** `cold_outreach` becomes `Cold outreach`. */
export function sentence(key: string): string {
  const s = key.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Currency = 'NPR' | 'INR' | 'USD';

/** A server-sent amount grouped by the tenant's number system, or null when none is set. Never adds amounts up. */
export function moneyOrNull(
  value: string | null,
  currency: Currency,
  numberSystem?: NumberSystem,
): string | null {
  return value === null ? null : money(value, currency, numberSystem);
}
