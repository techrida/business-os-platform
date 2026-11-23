import 'server-only';

import type { TermPreset } from '@bos/contracts';

import type { Session } from '@/lib/session';
import { listTaxCodes } from '@/lib/api-tax-codes';
import { listTermPresets } from '@/lib/api-term-presets';
import { getPermissionCheck } from '@/lib/live-permissions';

import * as api from './api';
import type { ContactOption } from './quote-builder';
import type { PaymentTerm, TaxCode } from './schemas';

export interface Lookups {
  /** Each is null when its call failed, so the builder can say so instead of showing an empty list. */
  taxCodes: TaxCode[] | null;
  paymentTerms: PaymentTerm[] | null;
  contacts: ContactOption[] | null;
  /** Saved term sets for the Terms fields. null when the call failed or the caller may not read it: the builder then shows no dropdown and no error. */
  termPresets: TermPreset[] | null;
  /** True for a session that may edit saved terms (`settings.finance.write`, Finance or Accountant, or `admin.settings.write`, the Founder): the Terms dropdowns then end with "Add more". Read from the live grants, as the Saved terms page is; the API still enforces every edit. */
  canAddTerms: boolean;
}

/** The lists the form's selects need. A failed list degrades that select; it never fails the page. */
export async function loadLookups(session: Session, customerId: string): Promise<Lookups> {
  const [tax, terms, contacts, presets, can] = await Promise.allSettled([
    listTaxCodes(session),
    api.listPaymentTerms(session),
    api.listContacts(session, customerId),
    listTermPresets(session),
    getPermissionCheck(session),
  ]);
  return {
    taxCodes: tax.status === 'fulfilled' ? tax.value : null,
    paymentTerms: terms.status === 'fulfilled' ? terms.value : null,
    contacts:
      contacts.status === 'fulfilled'
        ? contacts.value.map((c) => ({
            id: c.id,
            label: [c.fullName, c.title, c.email].filter(Boolean).join(' · '),
            name: c.fullName,
            detail: [c.title, c.email].filter(Boolean).join(' · ') || undefined,
          }))
        : null,
    termPresets: presets.status === 'fulfilled' ? presets.value : null,
    canAddTerms:
      can.status === 'fulfilled' &&
      (can.value('settings.finance.write') || can.value('admin.settings.write')),
  };
}
