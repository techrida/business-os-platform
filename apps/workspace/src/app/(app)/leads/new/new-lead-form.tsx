'use client';
// The new-lead page's client half: LeadForm with its data sources (BOS-UI-002). The Company field searches the
// customers and open leads the user may read through the page's BFF routes, the Contact person field lists the linked
// customer's contacts the same way, and a lead picked from "Already a lead" opens in the same tab. The page itself is
// a server component and cannot pass callbacks.
import { useRouter } from 'next/navigation';
import { type ComponentProps } from 'react';

import { LeadForm } from '@/components/p2/crm/lead-form';

import { loadCustomerContacts } from '../_lib/customer-contacts';
import { searchCompanies } from '../_lib/use-company-search';

export function NewLeadForm(
  props: Omit<ComponentProps<typeof LeadForm>, 'companySearch' | 'loadContacts' | 'onOpenLead'>,
) {
  const router = useRouter();
  return (
    <LeadForm
      {...props}
      companySearch={searchCompanies}
      loadContacts={loadCustomerContacts}
      onOpenLead={(id) => router.push(`/leads/${encodeURIComponent(id)}`)}
    />
  );
}
