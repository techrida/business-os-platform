import { money } from '@/lib/kernel-format';

/** `cold_outreach` becomes `Cold outreach`. */
export function sentence(key: string): string {
  const s = key.replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Currency = 'NPR' | 'INR' | 'USD';

/** A server-sent amount in lakh grouping, or null when none is set. Never adds amounts up. */
export function moneyOrNull(value: string | null, currency: Currency): string | null {
  return value === null ? null : money(value, currency);
}
