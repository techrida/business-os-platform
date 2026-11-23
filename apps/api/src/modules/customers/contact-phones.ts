// The phone numbers of customer contacts (FX9, 0192): several per person, each with its own country. A contact's
// numbers are written as a whole set inside the transaction that creates or changes the contact (the rows carry no
// version of their own), and read back primary first, then in their saved order. Lead conversion writes the new
// contact's numbers through replaceContactPhones too, so every path is held to the same rules.
import { type PartyPhone, type PartyPhoneInput, PartyPhonesSchema } from '@bos/contracts';
import { customerContactPhones, customerContacts } from '@bos/db';
import { BadRequestException } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { type Db, type DbTransaction } from '../../platform/db/db.module';

/**
 * Replaces the numbers of one contact with `phones`, in their array order (`sort_order` is the index). A non-empty
 * set needs exactly one primary: when none is marked the first row becomes it, two or more marked is a 400, as are
 * a number listed twice and a number that is not valid for its country. Callers that skip the request schema
 * (lead conversion, imports) are checked here the same way. An empty list removes every number.
 */
export async function replaceContactPhones(
  tx: DbTransaction,
  input: { tenantId: string; contactId: string; phones: readonly PartyPhoneInput[] },
): Promise<void> {
  const { tenantId, contactId } = input;
  const marked = input.phones.some((phone) => phone.isPrimary);
  const phones = input.phones.map((phone, index) => ({
    ...phone,
    isPrimary: marked ? phone.isPrimary : index === 0,
  }));
  const checked = PartyPhonesSchema.safeParse(phones);
  if (!checked.success) {
    const message = checked.error.issues[0]?.message ?? 'invalid phone numbers';
    throw new BadRequestException({
      code: 'bad_request',
      message,
      fieldErrors: { phones: message },
    });
  }
  await tx
    .delete(customerContactPhones)
    .where(
      and(
        eq(customerContactPhones.tenantId, tenantId),
        eq(customerContactPhones.contactId, contactId),
      ),
    );
  if (phones.length === 0) return;
  await tx.insert(customerContactPhones).values(
    phones.map((phone, index) => ({
      tenantId,
      contactId,
      country: phone.country,
      e164: phone.e164,
      label: phone.label ?? null,
      sortOrder: index,
      isPrimary: phone.isPrimary,
    })),
  );
}

/**
 * The numbers of each contact in `contactIds`, primary first, then in their saved order. Every id is a key of the
 * result; a contact without numbers maps to an empty list. The table has no row security (tenant-level, like
 * customer_contacts), so the read filters on the tenant itself.
 */
export async function loadContactPhones(
  db: Db | DbTransaction,
  tenantId: string,
  contactIds: readonly string[],
): Promise<Map<string, PartyPhone[]>> {
  const byContact = new Map<string, PartyPhone[]>(contactIds.map((id) => [id, []]));
  if (contactIds.length === 0) return byContact;
  const rows = await db
    .select({
      contactId: customerContactPhones.contactId,
      country: customerContactPhones.country,
      e164: customerContactPhones.e164,
      label: customerContactPhones.label,
      isPrimary: customerContactPhones.isPrimary,
    })
    .from(customerContactPhones)
    .where(
      and(
        eq(customerContactPhones.tenantId, tenantId),
        inArray(customerContactPhones.contactId, [...contactIds]),
      ),
    )
    .orderBy(
      sql`${customerContactPhones.isPrimary} DESC`,
      asc(customerContactPhones.sortOrder),
      asc(customerContactPhones.id),
    );
  for (const { contactId, country, ...phone } of rows) {
    byContact.get(contactId)?.push({ ...phone, country: country as PartyPhone['country'] });
  }
  return byContact;
}

/**
 * The primary phone of each customer in `customerIds`: the primary number of the customer's primary contact (R6A, for
 * the customers list). One query for the whole page, so the list has no N+1. A customer without a primary contact, or
 * whose primary contact has no primary number, is not a key of the result. Tenant-level tables, so the read filters on
 * the tenant itself; the caller has already limited `customerIds` to customers it may read.
 */
export async function loadPrimaryPhones(
  db: Db | DbTransaction,
  tenantId: string,
  customerIds: readonly string[],
): Promise<Map<string, PartyPhone>> {
  const byCustomer = new Map<string, PartyPhone>();
  if (customerIds.length === 0) return byCustomer;
  const rows = await db
    .select({
      customerId: customerContacts.customerId,
      country: customerContactPhones.country,
      e164: customerContactPhones.e164,
      label: customerContactPhones.label,
      isPrimary: customerContactPhones.isPrimary,
    })
    .from(customerContacts)
    .innerJoin(
      customerContactPhones,
      and(
        eq(customerContactPhones.tenantId, customerContacts.tenantId),
        eq(customerContactPhones.contactId, customerContacts.id),
        eq(customerContactPhones.isPrimary, true),
      ),
    )
    .where(
      and(
        eq(customerContacts.tenantId, tenantId),
        inArray(customerContacts.customerId, [...customerIds]),
        eq(customerContacts.isPrimary, true),
      ),
    );
  for (const { customerId, country, ...phone } of rows) {
    byCustomer.set(customerId, { ...phone, country: country as PartyPhone['country'] });
  }
  return byCustomer;
}
