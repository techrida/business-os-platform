'use server';

import type { CustomerDto } from '@bos/contracts';

import { listContacts, listCustomers } from '@/components/p2/customers/api';
import { ApiError } from '@/lib/api';
import { requireStaffSession } from '@/lib/bff';

/** What the conversion dialog shows of a customer it may link: enough to tell two organisations apart. */
export interface ConversionCustomer {
  id: string;
  name: string;
  number: string;
  /** The stored PAN or VAT number, or null. */
  pan: string | null;
}

const toOption = (c: CustomerDto): ConversionCustomer => ({
  id: c.id,
  name: c.legalName,
  number: c.number,
  pan: c.panVatNo,
});

/** A PAN or VAT number as compared: spaces and dashes out, upper case (the API's own match key). */
const panKey = (value: string): string => value.replace(/[\s-]+/g, '').toUpperCase();

/**
 * The live search behind the organisation boxes. Read through the existing customer list with the caller's token,
 * so the tenant scope and `customer.read` stay the API's. `query` is what was typed (name, number or PAN/VAT);
 * `pan`, when given, is looked up on its own and `panMatches` holds only the customers whose stored number is the
 * SAME number once spaces and dashes are removed: a duplicate PAN is almost certainly the same company.
 */
export async function searchConversionCustomers(
  query: string,
  pan?: string,
): Promise<{
  customers: ConversionCustomer[];
  panMatches: ConversionCustomer[];
  error: string;
}> {
  const session = await requireStaffSession('/leads');
  const q = query.trim();
  const wantedPan = pan === undefined ? '' : panKey(pan);
  if ((!q || q.length > 100) && !wantedPan) return { customers: [], panMatches: [], error: '' };
  try {
    const [byText, byPan] = await Promise.all([
      q && q.length <= 100 ? listCustomers(session, { q, limit: 20 }) : null,
      wantedPan && wantedPan.length <= 100
        ? listCustomers(session, { q: wantedPan, limit: 20 })
        : null,
    ]);
    return {
      customers: (byText?.items ?? []).filter((c) => c.mergedIntoId == null).map(toOption),
      panMatches: (byPan?.items ?? [])
        .filter(
          (c) => c.mergedIntoId === null && c.panVatNo !== null && panKey(c.panVatNo) === wantedPan,
        )
        .map(toOption),
      error: '',
    };
  } catch {
    return {
      customers: [],
      panMatches: [],
      error: 'Organisations could not be loaded. Check your access and try again.',
    };
  }
}

export async function loadConversionContacts(customerId: string) {
  const session = await requireStaffSession('/leads');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customerId)) {
    return { options: [], error: 'Choose a customer first.', unreadable: false };
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
      unreadable: false,
    };
  } catch (err) {
    // 403/404: the caller may not open this customer (a lead can stay linked to one its viewer cannot read).
    return {
      options: [],
      error: 'Contacts could not be loaded. Check your access and try again.',
      unreadable: err instanceof ApiError && (err.status === 403 || err.status === 404),
    };
  }
}
