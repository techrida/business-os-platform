// A lead person's phone numbers (FX9): rows of app.lead_phones, replaced as a set inside the lead's own create or
// edit transaction, never edited in place. `leads.phones_search` mirrors them (E.164, space-separated in sort order,
// NULL for none) so the list search keeps one trigram index on leads; whoever writes the phones writes it too.
// Shared with lead conversion and duplicate detection: keep these signatures stable.
import { type CountryCode, type PartyPhone, type PartyPhoneInput } from '@bos/contracts';
import { leadPhones, leads } from '@bos/db';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { type Db } from '../../platform/db/db.module';
import { type DbTransaction } from '../../platform/db/tx';

/** The entity a lead belongs to. */
export interface LeadPhonesScope {
  tenantId: string;
  organizationId: string;
}

/** `leads.phones_search` for these numbers, in the order given (their sort order); null when there are none. */
export function phonesSearchText(phones: readonly Pick<PartyPhoneInput, 'e164'>[]): string | null {
  return phones.length === 0 ? null : phones.map((phone) => phone.e164).join(' ');
}

/**
 * Replaces the lead's numbers with `phones` (sort order is the list order) and brings `leads.phones_search` in line.
 * The list must already be valid (`PartyPhonesSchema`: one primary, no repeats). The lead's search text is written
 * only when it differs, so a caller that already set it in its own insert or versioned update adds no second row
 * change (and no second audit row).
 */
export async function replaceLeadPhones(
  tx: DbTransaction,
  args: LeadPhonesScope & { leadId: string; phones: readonly PartyPhoneInput[] },
): Promise<void> {
  const { tenantId, organizationId, leadId, phones } = args;
  await tx
    .delete(leadPhones)
    .where(
      and(
        eq(leadPhones.tenantId, tenantId),
        eq(leadPhones.organizationId, organizationId),
        eq(leadPhones.leadId, leadId),
      ),
    );
  if (phones.length > 0) {
    await tx.insert(leadPhones).values(
      phones.map((phone, index) => ({
        tenantId,
        organizationId,
        leadId,
        country: phone.country,
        e164: phone.e164,
        label: phone.label ?? null,
        sortOrder: index,
        isPrimary: phone.isPrimary,
      })),
    );
  }
  const search = phonesSearchText(phones);
  await tx
    .update(leads)
    .set({ phonesSearch: search })
    .where(
      and(
        eq(leads.tenantId, tenantId),
        eq(leads.organizationId, organizationId),
        eq(leads.id, leadId),
        sql`${leads.phonesSearch} IS DISTINCT FROM ${search}`,
      ),
    );
}

/**
 * The numbers of each lead, as the API returns them: primary first, then in their saved order. A lead without
 * numbers maps to an empty list. `leadIds` should come from a query already scoped to the caller.
 */
export async function loadLeadPhones(
  db: Db | DbTransaction,
  scope: LeadPhonesScope,
  leadIds: readonly string[],
): Promise<Map<string, PartyPhone[]>> {
  const byLead = new Map<string, PartyPhone[]>(leadIds.map((id) => [id, []]));
  if (leadIds.length === 0) return byLead;
  const rows = await db
    .select({
      leadId: leadPhones.leadId,
      country: leadPhones.country,
      e164: leadPhones.e164,
      label: leadPhones.label,
      isPrimary: leadPhones.isPrimary,
    })
    .from(leadPhones)
    .where(
      and(
        eq(leadPhones.tenantId, scope.tenantId),
        eq(leadPhones.organizationId, scope.organizationId),
        inArray(leadPhones.leadId, [...new Set(leadIds)]),
      ),
    )
    .orderBy(desc(leadPhones.isPrimary), asc(leadPhones.sortOrder), asc(leadPhones.id));
  for (const { leadId, ...phone } of rows) {
    byLead.get(leadId)?.push({ ...phone, country: phone.country as CountryCode });
  }
  return byLead;
}

/** The numbers of one lead (see loadLeadPhones). */
export async function loadPhonesOfLead(
  db: Db | DbTransaction,
  scope: LeadPhonesScope,
  leadId: string,
): Promise<PartyPhone[]> {
  return (await loadLeadPhones(db, scope, [leadId])).get(leadId) ?? [];
}

/**
 * Whether `sent` is the list the lead already has: the same numbers in the same saved order (`storedSearch` is the
 * lead's `phones_search`), each with the same country, label and primary mark. `stored` may be in any order.
 */
export function sameLeadPhones(
  stored: readonly PartyPhone[],
  storedSearch: string | null,
  sent: readonly PartyPhoneInput[],
): boolean {
  if (stored.length !== sent.length || phonesSearchText(sent) !== storedSearch) return false;
  const byNumber = new Map(stored.map((phone) => [phone.e164, phone]));
  return sent.every((phone) => {
    const was = byNumber.get(phone.e164);
    return (
      was !== undefined &&
      was.country === phone.country &&
      (was.label ?? null) === (phone.label ?? null) &&
      was.isPrimary === phone.isPrimary
    );
  });
}
