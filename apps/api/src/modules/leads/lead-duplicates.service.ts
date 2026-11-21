// LeadDuplicatesService: the duplicate hint of the new-lead form (F1-Q54 a). Read-only, and never a block: it only
// names leads and customers that look like the party being typed, so the salesperson can open them first.
// - "authorization is deny-by-default": a lead match goes through the leads list's own predicate (scoped() plus
//   scopeWhereFor(principal, leads, 'crm.lead.read'), the SQL twin of can()), and a customer candidate through the
//   pure can(principal, 'customer.read', customerRef(...)) that GET /v1/customers/:id decides with. A record the
//   caller may not read is dropped before anything about it (id, name, count) leaves this service.
// - Tenant-scoped always: every query filters the caller's tenant (and, for leads, the acting entity).
// Matching: email lower-cased and trimmed, equal; phone by its last 7 to 10 digits (E.164 stores digits after '+');
// company and person by pg_trgm word similarity (the `<%` operator the 0059/0060 trigram indexes serve, at
// searchPage's threshold) or a case-insensitive prefix.
import {
  LEAD_DUPLICATE_LIMIT,
  LEAD_DUPLICATE_MIN_LENGTH,
  LEAD_DUPLICATE_MIN_PHONE_DIGITS,
  type LeadDuplicateField,
  type LeadDuplicateMatch,
  type LeadDuplicatesQuery,
} from '@bos/contracts';
import { customerContacts, customers, leads, scoped } from '@bos/db';
import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { scopeWhereFor } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import { DB, type Db, inTransaction, type DbTransaction } from '../../platform/db/db.module';
import { escapeLike, FUZZY_WORD_SIMILARITY } from '../../platform/list';
import { customerRef } from '../customers/customers.service';
import { LeadsCaller } from './leads.caller';

/** Customer rows read before the per-record can() filter; the hint shows at most LEAD_DUPLICATE_LIMIT of them. */
const CUSTOMER_CANDIDATES = 25;

/** The typed fields, normalised; a field too short to be useful is undefined and never looked up. */
export interface DuplicateProbe {
  company?: string;
  name?: string;
  email?: string;
  /** The last 7 to 10 digits of the typed phone. */
  phoneTail?: string;
}

/** Normalises the query; null when no field is long enough to look up. */
export function duplicateProbe(q: LeadDuplicatesQuery): DuplicateProbe | null {
  const text = (v: string | undefined) => {
    const t = v?.trim().replace(/\s+/g, ' ');
    return t !== undefined && t.length >= LEAD_DUPLICATE_MIN_LENGTH ? t : undefined;
  };
  const email = text(q.email)?.toLowerCase();
  const digits = (q.phone ?? '').replace(/\D/g, '');
  const probe: DuplicateProbe = {
    company: text(q.company),
    name: text(q.name),
    email,
    phoneTail: digits.length >= LEAD_DUPLICATE_MIN_PHONE_DIGITS ? digits.slice(-10) : undefined,
  };
  return Object.values(probe).some((v) => v !== undefined) ? probe : null;
}

/** `q <% column` (served by the trigram GIN index) or a case-insensitive prefix. */
const similar = (q: string, column: AnyPgColumn): SQL =>
  sql`(${q}::text <% ${column} OR ${column} ILIKE ${`${escapeLike(q)}%`})`;

/** The stored E.164 number ends in the typed digits (only digits follow its '+'). */
const phoneEndsWith = (tail: string, column: AnyPgColumn): SQL =>
  sql`right(${column}, ${tail.length}) = ${tail}`;

/** A boolean column of the select: the SQL, or a constant false when the field was not typed. */
const flag = (value: string | undefined, build: (v: string) => SQL): SQL<boolean> =>
  value === undefined ? sql<boolean>`false` : sql<boolean>`coalesce(${build(value)}, false)`;

const fieldsOf = (row: Record<LeadDuplicateField, boolean>): LeadDuplicateField[] =>
  (['company', 'name', 'email', 'phone'] as const).filter((f) => row[f]);

@Injectable()
export class LeadDuplicatesService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly caller: LeadsCaller,
  ) {}

  async find(q: LeadDuplicatesQuery): Promise<LeadDuplicateMatch[]> {
    const probe = duplicateProbe(q);
    if (probe === null) return [];
    return inTransaction(this.db, async (tx) => {
      // searchPage's typo tolerance, transaction-local.
      await tx.execute(
        sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${FUZZY_WORD_SIMILARITY}, true)`,
      );
      const found = [...(await this.customers(tx, probe)), ...(await this.leads(tx, probe))];
      // More fields matched first; customers before leads on a tie (the record a lead would convert into).
      return found
        .map((m, i) => ({ m, i }))
        .sort((a, b) => b.m.matchedOn.length - a.m.matchedOn.length || a.i - b.i)
        .slice(0, LEAD_DUPLICATE_LIMIT)
        .map(({ m }) => m);
    });
  }

  /** Leads under the leads list's read scope (see the file header). */
  private async leads(tx: DbTransaction, p: DuplicateProbe): Promise<LeadDuplicateMatch[]> {
    const { scope, principal } = this.caller.current();
    const company = flag(p.company, (v) => similar(v, leads.companyName));
    const name = flag(p.name, (v) => similar(v, leads.contactName));
    const email = flag(p.email, (v) => sql`${leads.emailNorm} = ${v}`);
    const phone = flag(p.phoneTail, (v) => phoneEndsWith(v, leads.phoneE164));
    const rows = await tx
      .select({
        id: leads.id,
        number: leads.number,
        companyName: leads.companyName,
        company,
        name,
        email,
        phone,
      })
      .from(leads)
      .where(
        scoped(scope).where(
          leads,
          and(scopeWhereFor(principal, leads, 'crm.lead.read'), or(company, name, email, phone)),
        ),
      )
      // Strongest first (an exact email or phone over a similar name), so the cap never drops a sure match.
      .orderBy(
        desc(sql`${email}::int + ${phone}::int`),
        desc(sql`${company}::int + ${name}::int`),
        desc(leads.createdAt),
        desc(leads.id),
      )
      .limit(LEAD_DUPLICATE_LIMIT);
    return rows.map((r) => ({
      kind: 'lead' as const,
      id: r.id,
      label: `${r.companyName} (${r.number})`,
      matchedOn: fieldsOf(r),
    }));
  }

  /**
   * Customers of the tenant (they belong to no entity) that match by name or through a contact, then filtered one
   * by one with can(): a customer the caller may not read is dropped here, before it is labelled or counted.
   */
  private async customers(tx: DbTransaction, p: DuplicateProbe): Promise<LeadDuplicateMatch[]> {
    const { scope, principal } = this.caller.current();
    if (principal.orgKind !== 'staff') return [];
    const company = flag(p.company, (v) => similar(v, customers.legalName));
    const name = flag(p.name, (v) => similar(v, customerContacts.fullName));
    const email = flag(p.email, (v) => sql`${customerContacts.emailNorm} = ${v}`);
    const phone = flag(p.phoneTail, (v) => phoneEndsWith(v, customerContacts.phoneE164));
    const rows = await tx
      .select({
        id: customers.id,
        tenantId: customers.tenantId,
        ownerUserId: customers.ownerUserId,
        legalName: customers.legalName,
        company: sql<boolean>`bool_or(${company})`,
        name: sql<boolean>`bool_or(${name})`,
        email: sql<boolean>`bool_or(${email})`,
        phone: sql<boolean>`bool_or(${phone})`,
      })
      .from(customers)
      .leftJoin(
        customerContacts,
        and(
          eq(customerContacts.tenantId, customers.tenantId),
          eq(customerContacts.customerId, customers.id),
        ),
      )
      .where(
        and(
          eq(customers.tenantId, scope.tenantId),
          isNull(customers.mergedIntoId),
          or(company, name, email, phone),
        ),
      )
      .groupBy(customers.id)
      // Exact contact matches first, then name; the per-record can() below runs on these candidates.
      .orderBy(
        desc(sql`bool_or(${email}) OR bool_or(${phone})`),
        desc(sql`bool_or(${company})`),
        customers.legalName,
        customers.id,
      )
      .limit(CUSTOMER_CANDIDATES);
    return rows
      .filter((r) => can(principal, 'customer.read', customerRef(r, principal)).allowed)
      .slice(0, LEAD_DUPLICATE_LIMIT)
      .map((r) => ({
        kind: 'customer' as const,
        id: r.id,
        label: r.legalName,
        matchedOn: fieldsOf(r),
      }));
  }
}
