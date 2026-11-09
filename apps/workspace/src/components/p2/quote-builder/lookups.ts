import 'server-only';

import type { Session } from '@/lib/session';
import { listTaxCodes } from '@/lib/api-tax-codes';

import * as api from './api';
import type { ContactOption } from './quote-builder';
import type { PaymentTerm, TaxCode } from './schemas';

export interface Lookups {
  /** Each is null when its call failed, so the builder can say so instead of showing an empty list. */
  taxCodes: TaxCode[] | null;
  paymentTerms: PaymentTerm[] | null;
  contacts: ContactOption[] | null;
}

/** The three lists the form's selects need. A failed list degrades that select; it never fails the page. */
export async function loadLookups(session: Session, customerId: string): Promise<Lookups> {
  const [tax, terms, contacts] = await Promise.allSettled([
    listTaxCodes(session),
    api.listPaymentTerms(session),
    api.listContacts(session, customerId),
  ]);
  return {
    taxCodes: tax.status === 'fulfilled' ? tax.value : null,
    paymentTerms: terms.status === 'fulfilled' ? terms.value : null,
    contacts:
      contacts.status === 'fulfilled'
        ? contacts.value.map((c) => ({
            id: c.id,
            label: [c.fullName, c.title, c.email].filter(Boolean).join(' · '),
          }))
        : null,
  };
}
