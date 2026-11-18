'use server';

import { listContacts, listCustomers } from '@/components/p2/customers/api';
import { requireStaffSession } from '@/lib/bff';

/** Read through the existing APIs with the caller's token; their permissions remain authoritative. */
export async function searchConversionCustomers(query: string) {
  const session = await requireStaffSession('/leads');
  try {
    const result = await listCustomers(session, { q: query.trim().slice(0, 100), limit: 20 });
    return {
      options: result.items.map((c) => ({ id: c.id, label: `${c.legalName} · ${c.number}` })),
      error: '',
    };
  } catch {
    return {
      options: [],
      error: 'Customers could not be loaded. Check your access and try again.',
    };
  }
}

export async function loadConversionContacts(customerId: string) {
  const session = await requireStaffSession('/leads');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId)) {
    return { options: [], error: 'Choose a customer first.' };
  }
  try {
    const result = await listContacts(session, customerId);
    // A contact without an email cannot receive the opportunity's quotations, so it is shown but
    // cannot be chosen (the API refuses it with 422 contact_email_required).
    return {
      options: result.items.map((c) => ({
        id: c.id,
        label: c.email === null ? `${c.fullName} (no email address)` : c.fullName,
        disabled: c.email === null,
      })),
      error: '',
    };
  } catch {
    return { options: [], error: 'Contacts could not be loaded. Check your access and try again.' };
  }
}
