// CustomersService: the tenant-level customer records (ADR 0027, D17). Serves the NFRs:
// - "no gaps in a numbered series": the customer number is taken inside the create transaction, from the number
//   series of the tenant's DEFAULT entity (a customer belongs to no entity, so the series cannot follow the
//   acting one), and the acting entity is put back before the rows are written;
// - "every change is audited": all writes run in withTx(), so the audit triggers of parties, customers and
//   customer_contacts record the actor and the acting entity;
// - "no double effects" and "no lost updates": creates take an Idempotency-Key, a PATCH carries expectedVersion
//   and goes through updateVersioned();
// - "authorization is deny-by-default": a customer has no organization_id, so scoped() and scopeWhere() (which
//   filter on it) do not apply. Every query filters the tenant by hand, and the caller's grant scope is applied
//   in customerVisibleWhere() (customer-read-scope.ts), which mirrors can() for a record that names no entity.
import {
  type ContactDto,
  type CustomerActingEntity,
  type CustomerCan,
  type CustomerOwnerOption,
  type CustomerPortalAccess,
  type CreateContactBody,
  type CreateCustomerBody,
  type CustomerDto,
  type CountryCode,
  type CustomerFields,
  nepalPanProblem,
  type PartyPhone,
  type PartyAccountDto,
  type PaymentTerm,
  type Permission,
  ROLE_KEYS,
  type RoleKey,
  type UpdateCustomerBody,
  type UpdateCustomerTermsBody,
} from '@bos/contracts';
import {
  customerContacts,
  customers,
  idpOrgs,
  organizations,
  partyAccounts,
  parties,
  paymentTerms,
  userEntities,
  users,
  verificationCases,
} from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  UnprocessableEntityException,
} from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql, type SQL } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { can as decide, type Principal, type ResourceRef } from '../../platform/authz/can';
import { AuthzService } from '../../platform/authz/authz.service';
import { type LiveGrantDeps, liveGrantsOf } from '../../platform/authz/live-grants';
import { RoleCache } from '../../platform/authz/role-cache';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { READ_ONLY, withTx, type Actor, type TxScope } from '../../platform/db/tx';
import { searchPage } from '../../platform/list';
import { NumberingService } from '../../platform/settings/numbering.service';
import { nameIn, personLabel, personNameMap, personNames } from '../../platform/users/person-names';
import { roleLines } from '../../platform/users/person-role';
import { SqlUsersStore } from '../../platform/users/users.store';
import { customerHasPortalUser, firstAdminRule } from '../portal-access/first-admin';
import { loadContactPhones, loadPrimaryPhones, replaceContactPhones } from './contact-phones';
import { customerVisibleWhere } from './customer-read-scope';
import { VerificationService } from '../verification/verification.service';
import { CustomersCaller } from './customers.caller';
import {
  escapeLike,
  normalizeEmail,
  normalizeName,
  normalizePan,
  panMatchKey,
} from './customers.normalize';
import {
  type CustomerDetailDto,
  type CustomerList,
  type ListCustomersQuery,
} from './customers.types';

type CustomerRow = typeof customers.$inferSelect;
type ContactRow = typeof customerContacts.$inferSelect;
type PartyAccountRow = typeof partyAccounts.$inferSelect;
type Q = Db | DbTransaction;

/** Injection token for a test clock; production falls back to the system time. */
export const CUSTOMERS_CLOCK = Symbol('CUSTOMERS_CLOCK');

/** The numbering series key; its prefix is `CUS`, as in CUS-2082/83-00001. */
export const CUSTOMER_SERIES = 'CUS';

const PAN_INDEX = 'customers_tenant_pan_vat_no_unique';
const PRIMARY_CONTACT_INDEX = 'customer_contacts_tenant_customer_primary_unique';
const PARTY_ACCOUNT_INDEX = 'party_accounts_tenant_org_party_unique';

const iso = (d: Date): string => d.toISOString();

const customerNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Customer not found' });

const staleTerms = () =>
  new ConflictException({
    code: 'conflict',
    message: "This customer's terms were changed by someone else; reload them and try again",
  });

/** 409: the terms form was rendered for another acting entity than the one the caller acts for now. */
const entityChanged = () =>
  new ConflictException({
    code: 'conflict',
    reason: 'entity_changed',
    message: 'You switched legal entity since this page loaded; reload and try again',
  });

/** 422 `unprocessable` naming `paymentTermId`: the term is not one of the tenant's, or it is switched off. */
const badPaymentTerm = (message: string) =>
  new UnprocessableEntityException({
    code: 'unprocessable',
    message,
    fieldErrors: { paymentTermId: message },
  });

/** An NPR amount as stored: two decimals, half-up (D22). The contract already allows at most two. */
const npr = (amount: string): string =>
  new Decimal(amount).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

/**
 * 422 `contact_email_required`: a quotation is sent by email, so a customer must keep at least one contact
 * with an address. A contact without one is refused while the customer has none.
 */
export const contactEmailRequired = () =>
  new UnprocessableEntityException({
    code: 'contact_email_required',
    message:
      'This customer has no contact with an email yet, so this contact needs one. Quotations are sent by email.',
  });

export function toCustomerDto(row: CustomerRow): CustomerDto {
  return {
    id: row.id,
    number: row.number,
    legalName: row.legalName,
    panVatNo: row.panVatNo,
    industry: row.industry,
    relationship: row.relationship,
    ownerUserId: row.ownerUserId,
    defaultCurrency: row.defaultCurrency as CustomerDto['defaultCurrency'],
    country: row.country as CountryCode,
    address: { line: row.addressLine, city: row.addressCity },
    logoDocumentId: row.logoDocumentId,
    mergedIntoId: row.mergedIntoId,
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** A contact as the API returns it, with its numbers (loadContactPhones: primary first, then saved order). */
export function toContactDto(row: ContactRow, phones: PartyPhone[]): ContactDto {
  return {
    id: row.id,
    customerId: row.customerId,
    fullName: row.fullName,
    email: row.emailNorm,
    country: row.country as CountryCode,
    phones,
    title: row.title,
    isPrimary: row.isPrimary,
    version: row.version,
  };
}

/**
 * What authz decides on for one customer. A customer is tenant-level, so the entity of the ref is the caller's
 * acting entity (every entity of the tenant sees every customer, D17). `customerPartyId` is the customer's own
 * party id: a portal caller holding `customer_org` matches only their own company.
 */
export function customerRef(
  row: Pick<CustomerRow, 'tenantId' | 'id' | 'ownerUserId'>,
  p: Principal,
): ResourceRef {
  return {
    tenantId: row.tenantId,
    organizationId: p.organizationId,
    ownerUserId: row.ownerUserId,
    customerPartyId: row.id,
  };
}

/**
 * What `p` may do with this customer, by the same decisions the routes make on it: customer.write as PATCH does
 * (staff only), and for a case both grants VerificationService.create checks on the party (customer.write and
 * verification.read), on a customer that was not merged away (create refuses that one as not found). The terms
 * flags are the per-field checks of the terms route and of an owner change (staff only, same ref).
 */
export function customerCapabilities(
  row: Pick<CustomerRow, 'tenantId' | 'id' | 'ownerUserId' | 'mergedIntoId'>,
  p: Principal,
): CustomerCan {
  const ref = customerRef(row, p);
  const staff = p.orgKind === 'staff';
  const write = staff && decide(p, 'customer.write', ref).allowed;
  const readVerification = decide(p, 'verification.read', ref).allowed;
  return {
    write,
    readVerification,
    openVerification: write && readVerification && row.mergedIntoId === null,
    creditLimit: staff && decide(p, 'customers.credit_limit.write', ref).allowed,
    owner: staff && decide(p, 'customers.owner.write', ref).allowed,
    paymentTerms: write,
  };
}

/**
 * The portal access block of the detail read (F1-Q31): may `p` invite a portal admin now? The same checks, in the
 * same order, as PortalAccessService.grant before it reads the contact: customer.write on the record (staff only),
 * not merged away, the first-admin rule, then an approved KYB case. `blocked` is told only to a caller who may change
 * the customer, who would get the same answer from the grant route.
 */
export function customerPortalAccess(
  row: Pick<CustomerRow, 'ownerUserId' | 'mergedIntoId'>,
  p: Principal,
  can: CustomerCan,
  hasPortalUser: boolean,
  kybStatus: string | null,
): CustomerPortalAccess {
  if (!can.write || row.mergedIntoId !== null) {
    return { hasUser: hasPortalUser, canInvite: false, blocked: null };
  }
  const rule = firstAdminRule(row, p.userId, hasPortalUser);
  const blocked =
    rule !== 'ok' ? rule : kybStatus === 'approved' ? null : ('kyb_not_verified' as const);
  return { hasUser: hasPortalUser, canInvite: blocked === null, blocked };
}

/** The pg error behind `error`, which drizzle may wrap as `cause`. */
function pgError(error: unknown): { code?: string; constraint?: string } | undefined {
  for (
    let e: unknown = error, depth = 0;
    typeof e === 'object' && e !== null && depth < 3;
    depth++
  ) {
    const { code, constraint, cause } = e as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (typeof code === 'string' && code.length === 5) {
      return { code, ...(typeof constraint === 'string' ? { constraint } : {}) };
    }
    e = cause;
  }
  return undefined;
}

const isUnique = (error: unknown, constraint: string): boolean => {
  const e = pgError(error);
  return e?.code === '23505' && e.constraint === constraint;
};

export const duplicatePan = (pan: string, existing?: { id: string; number: string }) =>
  new ConflictException({
    code: 'duplicate_pan_vat',
    message:
      existing === undefined
        ? `A customer with PAN/VAT number ${pan} already exists`
        : `A customer with PAN/VAT number ${pan} already exists (${existing.number})`,
    ...(existing === undefined
      ? {}
      : { details: { customerId: existing.id, number: existing.number } }),
  });

@Injectable()
export class CustomersService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly numbering: NumberingService,
    private readonly authz: AuthzService,
    private readonly caller: CustomersCaller,
    private readonly audit: AuditService,
    @Optional() @Inject(CUSTOMERS_CLOCK) private readonly clock: () => Date = () => new Date(),
    /** Resets a customer's verification case on an identity edit; units that build this service by hand may omit it. */
    @Optional() private readonly verification?: VerificationService,
  ) {
    // The terms of an entity other than the acting one are read by the caller's live grants in THAT entity.
    this.liveGrants = {
      users: new SqlUsersStore(db),
      grants: { grantsFor: (...args) => new RoleCache(db).grantsFor(...args) },
    };
  }

  private readonly liveGrants: LiveGrantDeps;

  // -------------------------------------------------------------------------------------------------- list

  async list(query: ListCustomersQuery): Promise<CustomerList> {
    const { scope, principal } = this.caller.current();
    // The scope predicate and every filter are one `where`; searchPage ANDs the search onto it, so a fuzzy
    // match can never reach a customer the caller may not read.
    const where = and(
      customerVisibleWhere(principal, customers, 'customer.read', scope.tenantId),
      query.relationship === undefined
        ? undefined
        : inArray(customers.relationship, query.relationship),
      query.industry === undefined ? undefined : inArray(customers.industry, query.industry),
    );
    const order: SQL[] = [asc(customers.legalName), asc(customers.id)];
    if (query.q !== undefined) {
      // Names that start with the text come before names that only contain it.
      const prefix = `${escapeLike(query.q)}%`;
      order.unshift(
        sql`CASE WHEN ${customers.legalName} ILIKE ${prefix} OR ${customers.nameNorm} ILIKE ${prefix} THEN 0 ELSE 1 END`,
      );
    }
    const { rows, total } = await searchPage(this.db, {
      q: query.q,
      columns: [customers.legalName, customers.nameNorm, customers.number, customers.panVatNo],
      where,
      orderBy: order,
      limit: query.limit,
      offset: query.offset,
      rows: (tx, p) =>
        tx
          .select()
          .from(customers)
          .where(p.where)
          .orderBy(...p.orderBy)
          .limit(p.limit)
          .offset(p.offset),
      count: async (tx, w) => {
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(customers)
          .where(w);
        return count?.n ?? 0;
      },
    });
    if (principal.orgKind !== 'staff') return { items: rows.map(toCustomerDto), total };
    // U15a-Q3: the owner by name only (D46), read in the tenant, so the list needs no directory access.
    const names = await personNameMap(
      this.db,
      scope.tenantId,
      rows.map((r) => r.ownerUserId),
    );
    // R6A (D8): the primary contact's primary number, one query for the page.
    const phones = await loadPrimaryPhones(
      this.db,
      scope.tenantId,
      rows.map((r) => r.id),
    );
    return {
      items: rows.map((r) => ({
        ...toCustomerDto(r),
        ownerName: nameIn(names, r.ownerUserId),
        primaryPhone: phones.get(r.id) ?? null,
      })),
      total,
    };
  }

  /** The industries in use among the customers the caller may read, for the list's Industry filter. */
  async industries(): Promise<string[]> {
    const { scope, principal } = this.caller.current();
    const rows = await this.db
      .selectDistinct({ industry: customers.industry })
      .from(customers)
      .where(
        and(
          customerVisibleWhere(principal, customers, 'customer.read', scope.tenantId),
          isNotNull(customers.industry),
        ),
      )
      .orderBy(asc(customers.industry))
      .limit(100);
    return rows.flatMap((r) => (r.industry === null || r.industry === '' ? [] : [r.industry]));
  }

  /**
   * GET /v1/customers/owners: the people the customer card's owner picker offers, for whoever may change owners
   * (`customers.owner.write`; Management holds it without any people directory). Active staff users of the caller's
   * tenant who hold customer.write in the acting entity, by name then id: never a portal user, a disabled or invited
   * one, or another tenant's, and nobody who could not send the first portal invite. A subset of what an
   * owner change accepts (assertUser also takes an invited user), so a pick from this list is never refused for who
   * it names. Names only (D54-2): no address.
   */
  async owners(): Promise<CustomerOwnerOption[]> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    // The route's @Can, made again on the tenant: customers are tenant-level, so the grant is all-or-nothing.
    this.authz.assert('customers.owner.write', {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
    });
    // Only people who hold customer.write in this entity: the first portal invite must come from the customer's
    // owner (firstAdminRule), and an owner without customer.write could never send it. The candidates are active
    // staff with their roles in this entity (the membership's role_keys narrowing them, as the tenancy interceptor
    // does); the grant is then read through the RoleCache, so a tenant still on the built-in defaults and a
    // level-based grant count as they do on a request.
    const rows = await withTx(
      this.db,
      scope,
      actor,
      async (tx) =>
        (
          await tx.execute<{
            userId: string;
            displayName: string | null;
            roleKey: string;
            allowed: string[] | null;
          }>(sql`
            SELECT u.id AS "userId", u.display_name AS "displayName", r.role_key AS "roleKey",
                   e.role_keys AS "allowed"
            FROM app.users u
            JOIN app.idp_orgs o ON o.tenant_id = u.tenant_id AND o.id = u.idp_org_id
            JOIN app.user_roles r ON r.tenant_id = u.tenant_id AND r.user_id = u.id
            JOIN app.user_entities e ON e.tenant_id = u.tenant_id AND e.user_id = u.id
              AND e.organization_id = ${scope.organizationId}
            WHERE u.tenant_id = ${scope.tenantId} AND o.kind = 'staff' AND u.status = 'active'`)
        ).rows,
      READ_ONLY,
    );
    const people = new Map<string, { displayName: string | null; roles: RoleKey[] }>();
    for (const r of rows) {
      if (r.allowed !== null && !r.allowed.includes(r.roleKey)) continue;
      if (!(ROLE_KEYS as readonly string[]).includes(r.roleKey)) continue;
      const person = people.get(r.userId) ?? { displayName: r.displayName, roles: [] };
      person.roles.push(r.roleKey as RoleKey);
      people.set(r.userId, person);
    }
    const roles = await withTx(
      this.db,
      scope,
      actor,
      (tx) => roleLines(tx, scope, [...people.keys()]),
      READ_ONLY,
    );
    const out: CustomerOwnerOption[] = [];
    for (const [userId, person] of people) {
      if (
        await this.authz.rolesHold(
          scope.tenantId,
          scope.organizationId,
          person.roles,
          'customer.write',
        )
      ) {
        out.push({
          userId,
          displayName: personLabel(person.displayName),
          role: roles.get(userId) ?? null,
        });
      }
    }
    return out.sort(
      (a, b) => a.displayName.localeCompare(b.displayName) || a.userId.localeCompare(b.userId),
    );
  }

  /**
   * GET /v1/customers/payment-terms: the tenant's active payment terms, shortest first, for the customer card's
   * terms control and its labels. It is a customers route (`customer.read`, which the card needs anyway) so that
   * someone who edits terms without `quotation.read` still gets the list; the quotation form has its own copy
   * behind quotation.read. Terms are tenant company policy, not customer data.
   */
  async paymentTerms(): Promise<PaymentTerm[]> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    // The list is tenant policy, not a customer: any scope of customer.read (own included) may read it, so the
    // check is on the grant itself and not on a customer record.
    if (!principal.grants.has('customer.read')) {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
    }
    const rows = await withTx(
      this.db,
      scope,
      actor,
      (tx) =>
        tx
          .select({ id: paymentTerms.id, name: paymentTerms.name })
          .from(paymentTerms)
          .where(and(eq(paymentTerms.tenantId, scope.tenantId), eq(paymentTerms.isActive, true)))
          .orderBy(asc(paymentTerms.netDays), asc(paymentTerms.code)),
      READ_ONLY,
    );
    return rows.map((r) => ({ id: r.id, label: r.name }));
  }

  // --------------------------------------------------------------------------------------------------- read

  async get(id: string): Promise<CustomerDetailDto> {
    const { scope, actor, principal } = this.caller.current();
    const row = await this.find(this.db, scope.tenantId, id);
    if (row === undefined) throw customerNotFound();
    this.assertVisible('customer.read', row, principal);
    const dto = toCustomerDto(row);
    // The terms are entity-owned: show the ones of the entities this user may act for. A portal caller has
    // no entities, so the field is left out (not an empty list, which would claim "no terms set").
    if (principal.orgKind !== 'staff') return dto;
    // The owner by name, read in the customer's tenant only, so the page needs no admin directory (403 for Sales).
    const [accounts, people, caseStatus, hasPortalUser, actingEntity] = await Promise.all([
      this.accountsFor(scope, actor, principal, row),
      personNames(this.db, row.tenantId, [row.ownerUserId]),
      this.verificationStatus(scope.tenantId, id),
      customerHasPortalUser(this.db, row.tenantId, id),
      this.actingEntity(scope),
    ]);
    const can = customerCapabilities(row, principal);
    return {
      ...dto,
      accounts,
      actingEntity,
      people,
      can,
      // Only a caller who may change the customer learns it is verified (the edit form locks the identity fields; the
      // API refuses that edit for them anyway), so a reader without write sees no more than the case's existence.
      verification: {
        exists: caseStatus !== null,
        ...(can.write && caseStatus === 'approved' && { approved: true }),
      },
      portalAccess: customerPortalAccess(row, principal, can, hasPortalUser, caseStatus),
    };
  }

  /**
   * The status of the customer's verification case, or null when it has none. Only its existence reaches the page
   * (`verification`), and whether it is approved only through `portalAccess.blocked`, for a caller who may change the
   * customer; the case itself is read under verification.read.
   */
  private async verificationStatus(tenantId: string, partyId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ status: verificationCases.status })
      .from(verificationCases)
      .where(and(eq(verificationCases.tenantId, tenantId), eq(verificationCases.partyId, partyId)))
      .limit(1);
    return row?.status ?? null;
  }

  // ------------------------------------------------------------------------------------------------- create

  /**
   * The customer and its first contact, in one transaction: a refusal of either (a duplicate PAN, a bad owner)
   * leaves neither. The first contact has an email (the contract requires it) and becomes the main contact.
   */
  async create(body: CreateCustomerBody, idempotencyKey: string): Promise<CustomerDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    // The owner defaults to the creator; naming someone else is an owner change (R4c2 Q5a/Q6b).
    if (body.ownerUserId !== undefined && body.ownerUserId !== principal.userId) {
      this.authz.assert('customers.owner.write', {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      });
    }
    const now = this.clock();
    const { contact, duplicateOverrideReason, ...fields } = body;
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'customer.create', key: idempotencyKey, body },
        async () => {
          // The same PAN as stored is refused outright (409) before any reason is asked for, so a reason is
          // never asked for a create that cannot succeed.
          if (fields.panVatNo !== undefined) {
            await this.assertPanFree(tx, scope.tenantId, normalizePan(fields.panVatNo));
          }
          const matches = await this.duplicateCandidates(tx, scope.tenantId, principal, fields);
          if (matches.length > 0 && duplicateOverrideReason === undefined) {
            const onPan = matches.some((m) => m.on.includes('pan_vat'));
            const onName = matches.some((m) => m.on.includes('name'));
            const what =
              onPan && onName
                ? 'this name or PAN/VAT number'
                : onPan
                  ? 'this PAN/VAT number'
                  : 'this name';
            throw new BadRequestException({
              code: 'bad_request',
              reason: 'duplicate_reason_required',
              message: `A customer with ${what} already exists; give a reason to create another one`,
            });
          }
          const customer = await this.createInTx(tx, scope, fields, now);
          if (matches.length > 0) {
            await this.audit.record(tx, {
              action: 'customer.duplicate_override',
              entityType: 'customers',
              entityId: customer.id,
              after: { legalName: customer.legalName },
              meta: {
                reason: duplicateOverrideReason,
                matchedCustomerIds: matches.map((m) => m.customerId),
                matches,
              },
            });
          }
          await this.createContactInTx(
            tx,
            scope,
            customer.id,
            { ...contact, isPrimary: true },
            now,
          );
          return { status: 201, response: customer };
        },
      );
      return done.response;
    });
  }

  /**
   * F1-Q55: the live customers (not merged away) the caller can read that the workspace's advisory check
   * (`duplicate-check.ts`) would flag: the same normalised name, or the same PAN/VAT number once spaces and
   * hyphens are dropped ("123-456-789" against "123456789"). Each says which rules it matched. Limited to the
   * caller's read scope, so the check never reveals a customer they could not have been warned about. The very
   * same PAN as stored is refused on its own before this (409 `duplicate_pan_vat`).
   */
  private async duplicateCandidates(
    tx: DbTransaction,
    tenantId: string,
    principal: Principal,
    fields: Pick<CustomerFields, 'legalName' | 'panVatNo'>,
  ): Promise<{ customerId: string; on: ('name' | 'pan_vat')[] }[]> {
    const name = normalizeName(fields.legalName);
    const pan = fields.panVatNo === undefined ? null : panMatchKey(fields.panVatNo);
    const panKey = sql`regexp_replace(${customers.panVatNo}, '[[:space:]-]', '', 'g')`;
    const rows = await tx
      .select({
        id: customers.id,
        sameName: sql<boolean>`${customers.nameNorm} = ${name}`,
        samePan:
          pan === null ? sql<boolean>`false` : sql<boolean>`coalesce(${panKey} = ${pan}, false)`,
      })
      .from(customers)
      .where(
        and(
          customerVisibleWhere(principal, customers, 'customer.read', tenantId),
          isNull(customers.mergedIntoId),
          pan === null
            ? eq(customers.nameNorm, name)
            : sql`(${customers.nameNorm} = ${name} OR ${panKey} = ${pan})`,
        ),
      )
      .orderBy(asc(customers.id))
      .limit(20);
    return rows.map((r) => ({
      customerId: r.id,
      on: [
        ...(r.samePan ? (['pan_vat'] as const) : []),
        ...(r.sameName ? (['name'] as const) : []),
      ],
    }));
  }

  /**
   * The customer insert of create(), inside a transaction that withTx opened for `scope`: the PAN pre-check, the
   * owner check, the CUS number, the party row, and the customers row with its `name_norm`. It has no
   * idempotency and no caller checks (the caller of this method decides who may write); lead conversion calls it
   * inside its own transaction so the customer, contact, opportunity and lead change commit together.
   */
  async createInTx(
    tx: DbTransaction,
    scope: TxScope,
    body: CustomerFields,
    now: Date,
  ): Promise<CustomerDto> {
    // Reached by import and lead conversion as well, which skip the request schema.
    const panProblem = nepalPanProblem(body.country, body.panVatNo);
    if (panProblem !== null) throw new BadRequestException(panProblem);
    const pan = body.panVatNo === undefined ? null : normalizePan(body.panVatNo);
    if (pan !== null) await this.assertPanFree(tx, scope.tenantId, pan);
    if (body.ownerUserId !== undefined) {
      await this.assertUser(tx, scope.tenantId, body.ownerUserId);
    }
    const number = await this.issueNumber(tx, scope, now);
    try {
      const [party] = await tx
        .insert(parties)
        .values({
          tenantId: scope.tenantId,
          kind: 'customer',
          code: number,
          name: body.legalName,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: parties.id });
      const [row] = await tx
        .insert(customers)
        .values({
          id: party!.id,
          tenantId: scope.tenantId,
          number,
          legalName: body.legalName,
          nameNorm: normalizeName(body.legalName),
          panVatNo: pan,
          industry: body.industry ?? null,
          relationship: body.relationship,
          ownerUserId: body.ownerUserId ?? this.caller.current().principal.userId,
          defaultCurrency: body.defaultCurrency ?? null,
          country: body.country,
          addressLine: body.address.line,
          addressCity: body.address.city,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return toCustomerDto(row!);
    } catch (error) {
      // Two creates with the same PAN can both pass the pre-check; the unique index decides.
      if (pan !== null && isUnique(error, PAN_INDEX)) throw duplicatePan(pan);
      throw error;
    }
  }

  // ------------------------------------------------------------------------------------------------ update

  /**
   * `fields` holds only what the client sent (see sentFields), so an omitted `relationship` keeps its value.
   * A customer of another tenant is 404; a stale `expectedVersion` is 409 (updateVersioned).
   *
   * Who may send what (R4c2 Q5a/Q6b). The route is @AnyAuthenticated, because Management changes owners without
   * customer.write; so the service first requires one of the two grants at all, then:
   * - any field other than the owner: customer.write on the record (404 out of scope), as before;
   * - a new owner (sent and different from the stored one): customer read on the record (404 out of scope) and
   *   `customers.owner.write` (403); the new owner must be a staff user of the tenant who is not disabled (400,
   *   see assertUser). It is
   *   audited as `customer.owner_changed`;
   * - the stored owner sent again is not a change: no owner check, and with nothing else sent the caller still
   *   needs customer.write on the record or `customers.owner.write`.
   */
  async update(
    id: string,
    expectedVersion: number,
    fields: Omit<Partial<UpdateCustomerBody>, 'expectedVersion'>,
  ): Promise<CustomerDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    this.assertHoldsAny(principal, ['customer.write', 'customers.owner.write']);
    if (Object.values(fields).every((v) => v === undefined)) {
      throw new BadRequestException('at least one field to change is required');
    }
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      // updateVersioned answers 409 for a missing row too, so existence (and tenant) is decided here: 404.
      const row = await this.find(tx, scope.tenantId, id);
      if (row === undefined) throw customerNotFound();
      const editsOthers = Object.entries(fields).some(
        ([key, value]) => key !== 'ownerUserId' && value !== undefined,
      );
      const ownerChange =
        fields.ownerUserId !== undefined && fields.ownerUserId !== row.ownerUserId;
      if (editsOthers) {
        this.assertVisible('customer.write', row, principal);
      } else {
        this.assertVisible('customer.read', row, principal);
      }
      if (ownerChange) {
        this.authz.assert('customers.owner.write', customerRef(row, principal));
      } else if (
        !editsOthers &&
        !decide(principal, 'customers.owner.write', customerRef(row, principal)).allowed
      ) {
        // Only the stored owner was sent: no change, but still a write of the record.
        this.assertVisible('customer.write', row, principal);
      }

      // What really changes. The tax identity is the legal name, the PAN and the country: once the customer's
      // verification is approved they are locked, and before approval a change of them voids what was uploaded.
      const nextPan = fields.panVatNo === undefined ? undefined : normalizePan(fields.panVatNo);
      const legalNameChanged = fields.legalName !== undefined && fields.legalName !== row.legalName;
      const panChanged = nextPan !== undefined && nextPan !== row.panVatNo;
      const countryChanged = fields.country !== undefined && fields.country !== row.country;
      const identityChanged = legalNameChanged || panChanged || countryChanged;
      if (identityChanged) {
        const [verification] = await tx
          .select({ status: verificationCases.status })
          .from(verificationCases)
          .where(
            and(eq(verificationCases.tenantId, scope.tenantId), eq(verificationCases.partyId, id)),
          )
          // Locked, so an approval running now commits first and this edit then reads `approved` (409).
          .for('update');
        if (verification?.status === 'approved') {
          throw new ConflictException({
            code: 'customer_identity_locked',
            message: 'The legal name, PAN and country of a verified customer cannot be edited',
          });
        }
      }
      // An address is its street lines, city and country together (FX9), so a new address names its country.
      if (fields.address !== undefined && fields.country === undefined) {
        throw new BadRequestException({
          code: 'bad_request',
          message: 'an address needs its country',
          fieldErrors: { country: 'an address needs its country' },
        });
      }
      // A Nepal customer has a 9-digit PAN. The contract checks a body that sends both; here the other half comes from
      // the stored row: a new PAN against the stored country, or a new country against the stored PAN.
      if (fields.panVatNo !== undefined || fields.country !== undefined) {
        const problem = nepalPanProblem(
          fields.country ?? row.country,
          fields.panVatNo ?? row.panVatNo,
        );
        if (problem !== null) throw new BadRequestException(problem);
      }
      const pan = fields.panVatNo === undefined ? undefined : normalizePan(fields.panVatNo);
      if (pan !== undefined) await this.assertPanFree(tx, scope.tenantId, pan, id);
      if (ownerChange) await this.assertUser(tx, scope.tenantId, fields.ownerUserId!);
      // A PATCH that repeats the stored values writes nothing, so it keeps the version.
      const changes =
        identityChanged ||
        ownerChange ||
        (fields.industry !== undefined && fields.industry !== row.industry) ||
        (fields.relationship !== undefined && fields.relationship !== row.relationship) ||
        (fields.defaultCurrency !== undefined && fields.defaultCurrency !== row.defaultCurrency) ||
        (fields.address !== undefined &&
          (fields.address.line !== row.addressLine || fields.address.city !== row.addressCity));
      if (!changes) {
        if (row.version !== expectedVersion) {
          throw new ConflictException(
            'This record was changed by someone else; reload it and try again',
          );
        }
        return toCustomerDto(row);
      }
      try {
        const updated = await updateVersioned(tx, customers, id, expectedVersion, {
          ...(fields.legalName !== undefined && {
            legalName: fields.legalName,
            nameNorm: normalizeName(fields.legalName),
          }),
          ...(pan !== undefined && { panVatNo: pan }),
          ...(fields.industry !== undefined && { industry: fields.industry }),
          ...(fields.relationship !== undefined && { relationship: fields.relationship }),
          ...(ownerChange && { ownerUserId: fields.ownerUserId }),
          ...(fields.defaultCurrency !== undefined && { defaultCurrency: fields.defaultCurrency }),
          ...(fields.country !== undefined && { country: fields.country }),
          ...(fields.address !== undefined && {
            addressLine: fields.address.line,
            addressCity: fields.address.city,
          }),
          updatedAt: now,
        });
        if (fields.legalName !== undefined) {
          // The party row carries the same display name; keep the two in step.
          await tx
            .update(parties)
            .set({ name: fields.legalName, updatedAt: now })
            .where(and(eq(parties.tenantId, scope.tenantId), eq(parties.id, id)));
        }
        if (ownerChange) {
          await this.audit.record(tx, {
            action: 'customer.owner_changed',
            entityType: 'customers',
            entityId: id,
            before: { ownerUserId: row.ownerUserId },
            after: { ownerUserId: updated.ownerUserId },
          });
        }
        if (identityChanged && this.verification !== undefined) {
          const caseReset = await this.verification.resetForIdentityChangeInTx(
            tx,
            scope,
            id,
            'The customer’s legal name, PAN or country changed; upload the documents again.',
          );
          if (caseReset) {
            await this.audit.record(tx, {
              action: 'customer.verification_reset',
              entityType: 'customers',
              entityId: id,
              before: { legalName: row.legalName, pan: row.panVatNo, country: row.country },
              after: {
                legalName: updated.legalName,
                pan: updated.panVatNo,
                country: updated.country,
              },
            });
          }
        }
        return toCustomerDto(updated);
      } catch (error) {
        if (pan !== undefined && isUnique(error, PAN_INDEX)) throw duplicatePan(pan);
        throw error;
      }
    });
  }

  // ------------------------------------------------------------------------------------------------- terms

  /**
   * PATCH /v1/customers/:id/terms: the customer's terms with the ACTING entity (its `party_accounts` row, created
   * on the first save; UNIQUE tenant, entity, party). Row security is not on for party_accounts, so every read and
   * write here names the tenant AND the acting entity. Checks, all before any write:
   * - staff only, holding customer.write or `customers.credit_limit.write` at all (the route is
   *   @AnyAuthenticated because no one permission fits Finance, who sets limits without customer.write);
   * - `organizationId` (the entity the form was rendered for) is the acting entity: 409 `entity_changed` otherwise,
   *   so a form left open across an entity switch in another tab never writes the other entity's row;
   * - the customer is of this tenant and readable by the caller (404 otherwise);
   * - `creditLimit` sent: `customers.credit_limit.write` (403, never silently dropped);
   * - `paymentTermId` sent: customer.write on the record, as PATCH /v1/customers/:id; a changed term must be an
   *   active term of the tenant (422);
   * - the version: the existing row's must equal `expectedVersion`; no row and a version sent, or a row and no
   *   version, is 409 (the client's view is stale).
   * The row change is audited by the trigger; `customer.terms_changed` adds the before and after of both fields.
   */
  async updateTerms(id: string, body: UpdateCustomerTermsBody): Promise<PartyAccountDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    this.assertHoldsAny(principal, ['customer.write', 'customers.credit_limit.write']);
    if (body.organizationId !== scope.organizationId) throw entityChanged();
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const row = await this.find(tx, scope.tenantId, id);
      if (row === undefined) throw customerNotFound();
      this.assertVisible('customer.read', row, principal);
      // A customer merged into another carries no terms of its own; the terms belong to the surviving one.
      if (row.mergedIntoId !== null) throw customerNotFound();
      if (body.creditLimit !== undefined) {
        this.authz.assert('customers.credit_limit.write', customerRef(row, principal));
      }
      if (body.paymentTermId !== undefined) this.assertVisible('customer.write', row, principal);

      const [existing] = await tx
        .select()
        .from(partyAccounts)
        .where(
          and(
            eq(partyAccounts.tenantId, scope.tenantId),
            eq(partyAccounts.organizationId, scope.organizationId),
            eq(partyAccounts.partyId, id),
          ),
        )
        .limit(1);
      const termId = body.paymentTermId;
      if (termId !== undefined && termId !== null && termId !== existing?.paymentTermId) {
        await this.assertPaymentTerm(tx, scope.tenantId, termId);
      }
      const set = {
        ...(termId !== undefined && { paymentTermId: termId }),
        ...(body.creditLimit !== undefined && {
          creditLimit: body.creditLimit === null ? null : npr(body.creditLimit),
        }),
        updatedAt: now,
      };

      let saved: PartyAccountRow;
      if (existing === undefined) {
        if (body.expectedVersion !== undefined) throw staleTerms();
        try {
          const [inserted] = await tx
            .insert(partyAccounts)
            .values({
              tenantId: scope.tenantId,
              organizationId: scope.organizationId,
              partyId: id,
              ...set,
              version: 1,
              createdAt: now,
            })
            .returning();
          saved = inserted!;
        } catch (error) {
          // Two first saves at once: the unique index decides, and the loser's view is stale.
          if (isUnique(error, PARTY_ACCOUNT_INDEX)) throw staleTerms();
          throw error;
        }
      } else {
        if (body.expectedVersion !== existing.version) throw staleTerms();
        // Every key of the row in the predicate, not only id and version: row security is off for party_accounts.
        const [updated] = await tx
          .update(partyAccounts)
          .set({ ...set, version: sql`${partyAccounts.version} + 1` })
          .where(
            and(
              eq(partyAccounts.tenantId, scope.tenantId),
              eq(partyAccounts.organizationId, scope.organizationId),
              eq(partyAccounts.partyId, id),
              eq(partyAccounts.id, existing.id),
              eq(partyAccounts.version, existing.version),
            ),
          )
          .returning();
        if (updated === undefined) throw staleTerms();
        saved = updated;
      }

      const termsOf = (r: Pick<PartyAccountRow, 'paymentTermId' | 'creditLimit'> | undefined) => ({
        paymentTermId: r?.paymentTermId ?? null,
        creditLimit: r?.creditLimit ?? null,
      });
      await this.audit.record(tx, {
        action: 'customer.terms_changed',
        entityType: 'customers',
        entityId: id,
        before: termsOf(existing),
        after: termsOf(saved),
        meta: {
          organizationId: scope.organizationId,
          partyAccountId: saved.id,
          fields: [
            ...(termId !== undefined ? ['paymentTermId'] : []),
            ...(body.creditLimit !== undefined ? ['creditLimit'] : []),
          ],
          currency: 'NPR',
        },
      });
      const entity = await this.actingEntity(scope, tx);
      return {
        partyId: saved.partyId,
        organizationId: saved.organizationId,
        organizationName: entity.name,
        paymentTermId: saved.paymentTermId,
        creditLimit: saved.creditLimit,
        version: saved.version,
      };
    });
  }

  /** 422 unless `termId` is an active payment term of the tenant (payment terms are tenant-level). */
  private async assertPaymentTerm(tx: DbTransaction, tenantId: string, termId: string) {
    const [term] = await tx
      .select({ isActive: paymentTerms.isActive })
      .from(paymentTerms)
      .where(and(eq(paymentTerms.tenantId, tenantId), eq(paymentTerms.id, termId)))
      .limit(1);
    if (term === undefined) throw badPaymentTerm('This payment term does not exist');
    if (!term.isActive)
      throw badPaymentTerm('This payment term is switched off; choose an active one');
  }

  // ----------------------------------------------------------------------------------------------- contacts

  async listContacts(customerId: string): Promise<ContactDto[]> {
    const { scope, principal } = this.caller.current();
    const customer = await this.find(this.db, scope.tenantId, customerId);
    if (customer === undefined) throw customerNotFound();
    this.assertVisible('customer.read', customer, principal);
    const rows = await this.db
      .select()
      .from(customerContacts)
      .where(
        and(
          eq(customerContacts.tenantId, scope.tenantId),
          eq(customerContacts.customerId, customerId),
        ),
      )
      .orderBy(
        sql`${customerContacts.isPrimary} DESC`,
        asc(customerContacts.fullName),
        asc(customerContacts.id),
      );
    const phones = await loadContactPhones(
      this.db,
      scope.tenantId,
      rows.map((r) => r.id),
    );
    return rows.map((r) => toContactDto(r, phones.get(r.id) ?? []));
  }

  async createContact(
    customerId: string,
    body: CreateContactBody,
    idempotencyKey: string,
  ): Promise<ContactDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'customer.contact.create', key: idempotencyKey, body: { customerId, ...body } },
        async () => {
          // Decided here, not by the foreign key (which would be a 500, and would also tell apart "no such
          // customer" from "a customer of another tenant").
          const customer = await this.find(tx, scope.tenantId, customerId);
          if (customer === undefined) throw customerNotFound();
          this.assertVisible('customer.write', customer, principal);
          return {
            status: 201,
            response: await this.createContactInTx(tx, scope, customerId, body, now),
          };
        },
      );
      return done.response;
    });
  }

  /**
   * The contact insert of createContact(), inside a transaction that withTx opened for `scope`. The customer must
   * exist and the caller must be allowed to write it: the caller of this method decides both (a 409
   * `primary_contact_exists` is answered here, from the unique index). A contact without an email is refused
   * (422 `contact_email_required`) while the customer has no contact with one, on every path: add contact, the
   * first contact of a new customer and lead conversion.
   */
  async createContactInTx(
    tx: DbTransaction,
    scope: TxScope,
    customerId: string,
    body: CreateContactBody,
    now: Date,
  ): Promise<ContactDto> {
    if (body.email === undefined) {
      const [withEmail] = await tx
        .select({ id: customerContacts.id })
        .from(customerContacts)
        .where(
          and(
            eq(customerContacts.tenantId, scope.tenantId),
            eq(customerContacts.customerId, customerId),
            isNotNull(customerContacts.emailNorm),
          ),
        )
        .limit(1);
      if (withEmail === undefined) throw contactEmailRequired();
    }
    try {
      const [row] = await tx
        .insert(customerContacts)
        .values({
          tenantId: scope.tenantId,
          customerId,
          fullName: body.fullName,
          emailNorm: body.email === undefined ? null : normalizeEmail(body.email),
          country: body.country,
          title: body.title ?? null,
          isPrimary: body.isPrimary,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      // The numbers go in with the contact, so a refused number leaves no contact behind.
      await replaceContactPhones(tx, {
        tenantId: scope.tenantId,
        contactId: row!.id,
        phones: body.phones,
      });
      const phones = await loadContactPhones(tx, scope.tenantId, [row!.id]);
      return toContactDto(row!, phones.get(row!.id) ?? []);
    } catch (error) {
      if (isUnique(error, PRIMARY_CONTACT_INDEX)) {
        throw new ConflictException({
          code: 'primary_contact_exists',
          message: 'This customer already has a primary contact',
        });
      }
      throw error;
    }
  }

  // ------------------------------------------------------------------------------------------------ helpers

  /** Record-level authz that answers 404, not 403, for a customer outside the caller's scope. */
  private assertVisible(action: Permission, row: CustomerRow, p: Principal): void {
    try {
      this.authz.assert(action, customerRef(row, p));
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw customerNotFound();
      throw error;
    }
  }

  /**
   * The route-level check of a route that more than one permission opens (@AnyAuthenticated): 403 unless the caller
   * holds at least one of `actions` at all, before any record is looked up, as @Can would.
   */
  private assertHoldsAny(p: Principal, actions: readonly Permission[]): void {
    if (actions.some((action) => decide(p, action).allowed)) return;
    this.authz.assert(actions[0]!);
  }

  /** Customers are written by staff only: a portal user holding customer.write by mistake is still refused. */
  private assertStaff(p: Principal): void {
    if (p.orgKind !== 'staff') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
    }
  }

  private async find(q: Q, tenantId: string, id: string): Promise<CustomerRow | undefined> {
    const [row] = await q
      .select()
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, id)));
    return row;
  }

  /** 409 `duplicate_pan_vat`, naming the customer that holds the number. `exceptId` is the one being edited. */
  private async assertPanFree(
    tx: DbTransaction,
    tenantId: string,
    pan: string,
    exceptId?: string,
  ): Promise<void> {
    const [existing] = await tx
      .select({ id: customers.id, number: customers.number })
      .from(customers)
      .where(
        and(
          eq(customers.tenantId, tenantId),
          eq(customers.panVatNo, pan),
          exceptId === undefined ? undefined : ne(customers.id, exceptId),
        ),
      )
      .limit(1);
    if (existing !== undefined) throw duplicatePan(pan, existing);
  }

  /**
   * The owner must be a staff user of this tenant who is not disabled: 400 (not a foreign-key 500) for an unknown
   * user, one of another tenant, a portal user and an inactive (disabled or locked) one. `details.assignmentReason`
   * is `not_active_staff`, the code the Lead owner card uses for the same refusal. An invited user (sign-up not
   * finished) is accepted, as before.
   */
  private async assertUser(tx: DbTransaction, tenantId: string, userId: string): Promise<void> {
    const [user] = await tx
      .select({ status: users.status, kind: idpOrgs.kind })
      .from(users)
      .innerJoin(idpOrgs, and(eq(idpOrgs.tenantId, users.tenantId), eq(idpOrgs.id, users.idpOrgId)))
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
      .limit(1);
    if (user === undefined || user.kind !== 'staff' || user.status === 'inactive') {
      throw new BadRequestException({
        code: 'bad_request',
        message: 'ownerUserId must be a staff user of this tenant who is not disabled',
        details: { assignmentReason: 'not_active_staff' },
      });
    }
  }

  /**
   * The next CUS number, from the number series of the tenant's default entity. NumberingService reads the
   * entity from the transaction's `bos.organization_id`, so that setting is pointed at the default entity for
   * the one call and put back right after (on a failure the transaction is rolled back, so nothing to restore).
   * The audit rows of the customer then carry the acting entity, as for every other tenant-level table.
   */
  private async issueNumber(tx: DbTransaction, scope: TxScope, now: Date): Promise<string> {
    const [entity] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.tenantId, scope.tenantId), eq(organizations.isDefault, true)))
      .limit(1);
    if (entity === undefined) {
      throw new Error(`tenant ${scope.tenantId} has no default entity to number customers from`);
    }
    await this.setActingEntity(tx, entity.id);
    const { number } = await this.numbering.issue(tx, CUSTOMER_SERIES, now);
    await this.setActingEntity(tx, scope.organizationId);
    return number;
  }

  private async setActingEntity(tx: DbTransaction, organizationId: string): Promise<void> {
    await tx.execute(sql`SELECT set_config('bos.organization_id', ${organizationId}, true)`);
  }

  /** The entity the caller acts for, by name: the one whose terms the terms route writes. */
  private async actingEntity(scope: TxScope, q: Q = this.db): Promise<CustomerActingEntity> {
    const [entity] = await q
      .select({ name: organizations.name })
      .from(organizations)
      .where(
        and(eq(organizations.tenantId, scope.tenantId), eq(organizations.id, scope.organizationId)),
      )
      .limit(1);
    return { organizationId: scope.organizationId, name: entity?.name ?? '' };
  }

  /**
   * The terms of the customer with the entities the caller may act for (user_entities) AND may read the customer
   * in: a membership alone is not enough (R5 FU4). The credit limit and payment term of an entity go to someone who
   * holds `customer.read` there, by the roles their membership of THAT entity allows, so Finance in one entity
   * and Warehouse only in another sees the first entity's terms and not the second's.
   */
  private async accountsFor(
    scope: TxScope,
    actor: Actor,
    principal: Principal,
    customer: CustomerRow,
  ): Promise<PartyAccountDto[]> {
    const tenantId = scope.tenantId;
    const userId = principal.userId;
    const id = customer.id;
    const rows = await this.db
      .select({
        partyId: partyAccounts.partyId,
        organizationId: partyAccounts.organizationId,
        organizationName: organizations.name,
        paymentTermId: partyAccounts.paymentTermId,
        creditLimit: partyAccounts.creditLimit,
        version: partyAccounts.version,
      })
      .from(partyAccounts)
      .leftJoin(
        organizations,
        and(
          eq(organizations.tenantId, partyAccounts.tenantId),
          eq(organizations.id, partyAccounts.organizationId),
        ),
      )
      .where(
        and(
          eq(partyAccounts.tenantId, tenantId),
          eq(partyAccounts.partyId, id),
          inArray(
            partyAccounts.organizationId,
            this.db
              .select({ id: userEntities.organizationId })
              .from(userEntities)
              .where(and(eq(userEntities.tenantId, tenantId), eq(userEntities.userId, userId))),
          ),
        ),
      )
      .orderBy(asc(partyAccounts.organizationId));
    const readable = await withTx(
      this.db,
      scope,
      actor,
      async (tx) => {
        const allowed = new Set<string>();
        for (const org of new Set(rows.map((r) => r.organizationId))) {
          if (await this.mayReadIn(tx, principal, customer, org)) allowed.add(org);
        }
        return allowed;
      },
      READ_ONLY,
    );
    return rows
      .filter((r) => readable.has(r.organizationId))
      .map((r) => ({
        partyId: r.partyId,
        organizationId: r.organizationId,
        organizationName: r.organizationName,
        paymentTermId: r.paymentTermId,
        creditLimit: r.creditLimit,
        version: r.version,
      }));
  }

  /**
   * Whether the caller reads this customer in legal entity `organizationId`: `customer.read` at a scope that
   * reaches the record, by the roles of their membership there, held in their token as well. The acting entity is the request's principal; any
   * other entity is read from the database now (liveGrantsOf), so a role taken away shows at once.
   */
  private async mayReadIn(
    tx: DbTransaction,
    principal: Principal,
    customer: CustomerRow,
    organizationId: string,
  ): Promise<boolean> {
    if (organizationId.toLowerCase() === principal.organizationId.toLowerCase()) {
      return decide(principal, 'customer.read', customerRef(customer, principal)).allowed;
    }
    // The token's roles bound what the user may do here too: a role added to the database since the token was
    // issued does not open another entity's terms through this one, as it would not open a request acting there.
    const tokenRoles = new Set<string>(principal.roles);
    const bounded: LiveGrantDeps = {
      grants: this.liveGrants.grants,
      users: {
        findById: (q, sc, userId) => this.liveGrants.users.findById(q, sc, userId),
        membershipsOf: (q, tenantId, userId) =>
          this.liveGrants.users.membershipsOf(q, tenantId, userId),
        rolesOf: async (q, tenantId, userId) =>
          (await this.liveGrants.users.rolesOf(q, tenantId, userId)).filter((r) =>
            tokenRoles.has(r),
          ),
      },
    };
    const live = await liveGrantsOf(
      tx,
      bounded,
      { tenantId: principal.tenantId, organizationId },
      principal.userId,
    );
    if (live.status !== 'active') return false;
    const there: Principal = {
      ...principal,
      organizationId,
      roles: live.roles,
      departmentId: live.departmentId,
      level: live.level,
      grants: live.grants,
    };
    return decide(there, 'customer.read', customerRef(customer, there)).allowed;
  }
}
