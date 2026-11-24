'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { apiCodeOf, apiReasonOf } from '@/lib/api-code';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getGrants, hasGrant } from '@/lib/grants';

import {
  createContact,
  createCustomer,
  getCustomer,
  grantCustomerPortalAccess,
  listCustomers,
  updateCustomer,
} from './api';
import { duplicateQueries, matchDuplicates, type DuplicateMatch } from './duplicate-check';
import type { ContactFormState, CustomerFormState, PortalInviteState } from './form-state';
import {
  CONTACT_EMAIL_REQUIRED,
  CUSTOMER_FIELDS,
  parseContact,
  parseCreateCustomer,
  parseUpdateCustomer,
  readPhoneRows,
  tidyCustomerValues,
  type ContactValues,
  type CustomerValues,
} from './forms';
import { isGuid } from './format';

/**
 * Server actions for the customer create and edit forms and the add-contact form. Each one asks
 * `requireStaffSession` first, checks `customer.write` (deny by default: the API still decides
 * every call), validates with the contracts' schemas, and words any refusal for a person. The
 * browser never sees the API URL or a token.
 */

const NO_WRITE =
  'Your roles do not include changing customers. Ask an administrator if you need to.';
const INCOMPLETE = 'This form is incomplete. Reload the page and try again.';

/** The page's key is a UUID; anything else in the hidden field was tampered with or lost. */
const KEY = /^[A-Za-z0-9-]{8,64}$/;

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

function keyOf(form: FormData): string {
  const submitted = text(form, 'idempotencyKey');
  return KEY.test(submitted) ? submitted : randomUUID();
}

/**
 * The posted name of each customer field. `AddressFields name="address"` posts the line, city and
 * country under `address.`; the country is the customer's own (top-level in the body).
 */
const POSTED_AS: Partial<Record<keyof CustomerValues, string>> = {
  line: 'address.line',
  city: 'address.city',
  country: 'address.country',
};

function customerValues(form: FormData): CustomerValues {
  const raw: Partial<CustomerValues> = {};
  for (const field of CUSTOMER_FIELDS) raw[field] = text(form, POSTED_AS[field] ?? field);
  return tidyCustomerValues(raw);
}

/**
 * Looks for the same company already on file. Advisory: a search that fails (the API is down, or
 * the route is not there yet) finds nothing, so it can never stop a customer being created.
 */
async function findDuplicates(
  session: Awaited<ReturnType<typeof requireStaffSession>>,
  input: { legalName: string; panVatNo?: string | undefined },
  excludeId?: string,
): Promise<DuplicateMatch[]> {
  const queries = duplicateQueries(input.legalName, input.panVatNo);
  const settled = await Promise.allSettled(
    queries.map((q) => listCustomers(session, { q, limit: 20 })),
  );
  const candidates = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value.items : []));
  return matchDuplicates(input, candidates, excludeId !== undefined ? { excludeId } : {});
}

export async function createCustomerAction(
  _prev: CustomerFormState,
  form: FormData,
): Promise<CustomerFormState> {
  const session = await requireStaffSession('/customers/new');
  const key = keyOf(form);
  if (!hasGrant(await getGrants(session), 'customer.write')) {
    return { key, errors: {}, error: NO_WRITE };
  }

  // The first contact's numbers: `PhoneListInput name="contactPhones"`.
  const parsed = parseCreateCustomer(customerValues(form), readPhoneRows(form, 'contactPhones'));
  if (!parsed.ok) return { key, errors: parsed.errors };

  if (text(form, 'ackDuplicates') !== 'yes') {
    const duplicates = await findDuplicates(session, parsed.data);
    if (duplicates.length > 0) {
      return {
        key,
        errors: {},
        duplicates,
        checked: { legalName: parsed.data.legalName, panVatNo: parsed.data.panVatNo ?? '' },
      };
    }
  }

  // "Create anyway" carries the person's reason (F1-Q55); the API audits it with the matches.
  const reason = text(form, 'duplicateOverrideReason').trim();
  const body = reason !== '' ? { ...parsed.data, duplicateOverrideReason: reason } : parsed.data;

  let id: string;
  try {
    id = (await createCustomer(session, body, key)).id;
  } catch (err) {
    if (apiReasonOf(err) === 'duplicate_reason_required') {
      // A possible duplicate exists (the same name, or the same PAN/VAT number without spaces and
      // hyphens): show what the search finds (it may be nothing the search can see) and ask for the
      // reason. Nothing was created, so the next try is a new create.
      return {
        key: randomUUID(),
        errors: {},
        duplicates: await findDuplicates(session, parsed.data),
        checked: { legalName: parsed.data.legalName, panVatNo: parsed.data.panVatNo ?? '' },
        needsReason: true,
      };
    }
    const failure = failureOf(err);
    return {
      // A 4xx is a final answer, so the next try is a new create. After a timeout or 5xx the first
      // call may have landed: keep the key so it cannot create the customer twice.
      key: failure.definite ? randomUUID() : key,
      errors: {},
      error: failure.message,
    };
  }

  revalidatePath('/customers');
  // `redirect` throws, so it stays outside the try block.
  redirect(`/customers/${encodeURIComponent(id)}?created=1`);
}

export async function updateCustomerAction(
  _prev: CustomerFormState,
  form: FormData,
): Promise<CustomerFormState> {
  const id = text(form, 'customerId');
  const key = randomUUID();
  if (!isGuid(id)) return { key, errors: {}, error: INCOMPLETE, reload: true };
  const session = await requireStaffSession(`/customers/${id}/edit`);
  if (!hasGrant(await getGrants(session), 'customer.write')) {
    return { key, errors: {}, error: NO_WRITE };
  }

  // The version the person was looking at. A different current version is the API's 409.
  const seen = Number(text(form, 'expectedVersion'));
  if (!Number.isInteger(seen) || seen < 1) {
    return { key, errors: {}, error: INCOMPLETE, reload: true };
  }

  let original;
  try {
    original = await getCustomer(session, id);
  } catch (err) {
    const failure = failureOf(err);
    return { key, errors: {}, error: failure.message };
  }

  const values = customerValues(form);
  // A verified customer's country is a disabled control, which a browser leaves out of the post: it is the stored one.
  if (!form.has('address.country')) values.country = original.country;
  const parsed = parseUpdateCustomer(values, { ...original, version: seen });
  if (!parsed.ok) {
    return 'nothingChanged' in parsed
      ? { key, errors: {}, notice: 'Nothing changed, so there is nothing to save.' }
      : { key, errors: parsed.errors };
  }

  try {
    await updateCustomer(session, id, parsed.data);
  } catch (err) {
    const failure = failureOf(err);
    return {
      key,
      errors: {},
      error:
        // Only a plain version conflict reads as "someone else changed it"; a 409 that names its
        // cause (a duplicate PAN/VAT number) keeps its own sentence.
        failure.status === 409 && failure.reload
          ? 'Someone else changed this customer after you opened it. Reload to see their changes, then make your edit again.'
          : failure.message,
      ...(failure.reload ? { reload: true } : {}),
    };
  }

  revalidatePath('/customers');
  revalidatePath(`/customers/${id}`);
  redirect(`/customers/${encodeURIComponent(id)}?saved=1`);
}

export async function addContactAction(
  prev: ContactFormState,
  form: FormData,
): Promise<ContactFormState> {
  const customerId = text(form, 'customerId');
  const key = keyOf(form);
  const same = { savedCount: prev.savedCount };
  if (!isGuid(customerId)) return { key, errors: {}, error: INCOMPLETE, ...same };
  const session = await requireStaffSession(`/customers/${customerId}`);
  if (!hasGrant(await getGrants(session), 'customer.write')) {
    return { key, errors: {}, error: NO_WRITE, ...same };
  }

  const values: ContactValues = {
    fullName: text(form, 'fullName'),
    title: text(form, 'title'),
    email: text(form, 'email'),
    country: text(form, 'country'),
    isPrimary: text(form, 'isPrimary') === 'on',
  };
  // The page says whether the customer still lacks a contact with an email; the API decides anyway.
  const parsed = parseContact(values, readPhoneRows(form, 'phones'), {
    requireEmail: text(form, 'requireEmail') === 'yes',
  });
  if (!parsed.ok) return { key, errors: parsed.errors, ...same };

  let created: Awaited<ReturnType<typeof createContact>>;
  try {
    created = await createContact(session, customerId, parsed.data, key);
  } catch (err) {
    const failure = failureOf(err);
    const code = apiCodeOf(err);
    const next = failure.definite ? randomUUID() : key;
    if (code === 'contact_email_required') {
      revalidatePath(`/customers/${customerId}`);
      return { key: next, errors: { email: CONTACT_EMAIL_REQUIRED }, ...same };
    }
    if (code === 'primary_contact_exists') {
      // Someone made a main contact after this page loaded: reload the page data so the checkbox
      // shows as taken, and say so in a toast. What was typed stays.
      revalidatePath(`/customers/${customerId}`);
      return {
        key: next,
        errors: {},
        primaryTaken: 'This customer already has a main contact. Untick it and save again.',
        ...same,
      };
    }
    return { key: next, errors: {}, error: failure.message, ...same };
  }

  revalidatePath(`/customers/${customerId}`);
  return {
    key: randomUUID(),
    errors: {},
    saved: `${parsed.data.fullName} was added.`,
    contactId: created.id,
    savedCount: prev.savedCount + 1,
  };
}

/** What a refused invite says, by the API's code (F1-Q31 and the K8 grant rules). */
const PORTAL_REFUSAL: Record<string, string> = {
  first_admin_owner_only: "Only this customer's account owner can invite its first portal admin.",
  account_owner_missing:
    'This customer has no account owner, and only the account owner can invite its first portal admin.',
  kyb_not_verified:
    "Portal access needs an approved KYB verification. Finish this customer's verification first.",
  customer_merged:
    'This customer was merged into another. Invite from the customer it was merged into.',
};

/**
 * Invite one of the customer's existing contacts as a portal admin (`POST /v1/customers/:id/portal-access`).
 * The form offers only existing contacts; the API decides who may invite (the account owner for the first admin).
 */
export async function invitePortalAdminAction(
  prev: PortalInviteState,
  form: FormData,
): Promise<PortalInviteState> {
  const customerId = text(form, 'customerId');
  const key = keyOf(form);
  const same = { savedCount: prev.savedCount };
  if (!isGuid(customerId)) return { key, errors: {}, error: INCOMPLETE, ...same };
  const session = await requireStaffSession(`/customers/${customerId}`);
  if (!hasGrant(await getGrants(session), 'customer.write')) {
    return { key, errors: {}, error: NO_WRITE, ...same };
  }
  const contactId = text(form, 'contactId');
  if (!isGuid(contactId)) {
    return { key, errors: { contactId: 'Choose which contact gets portal access.' }, ...same };
  }

  let email: string;
  let inviteSent: boolean;
  try {
    ({ email, inviteSent } = await grantCustomerPortalAccess(session, customerId, contactId, key));
  } catch (err) {
    const failure = failureOf(err);
    const next = failure.definite ? randomUUID() : key;
    const code = apiCodeOf(err);
    const known = code === undefined ? undefined : PORTAL_REFUSAL[code];
    if (known !== undefined) {
      revalidatePath(`/customers/${customerId}`);
      return { key: next, errors: {}, error: known, ...same };
    }
    if (failure.status === 404) {
      revalidatePath(`/customers/${customerId}`);
      return {
        key: next,
        errors: { contactId: 'This contact is no longer on this customer. Choose another one.' },
        ...same,
      };
    }
    return { key: next, errors: {}, error: failure.message, ...same };
  }

  revalidatePath(`/customers/${customerId}`);
  return {
    key: randomUUID(),
    errors: {},
    saved: inviteSent
      ? `Portal access granted. An invitation was sent to ${email}.`
      : `Portal access granted to ${email}. No invitation email was sent.`,
    savedCount: prev.savedCount + 1,
  };
}
