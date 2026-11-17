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
//   in visibleWhere(), which mirrors can() for a record that names no entity.
import {
  type Address,
  type ContactDto,
  type CreateContactBody,
  type CreateCustomerBody,
  type CustomerDto,
  type PartyAccountDto,
  type Permission,
  type UpdateCustomerBody,
} from '@bos/contracts';
import {
  customerContacts,
  customers,
  organizations,
  partyAccounts,
  parties,
  userEntities,
  users,
} from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { and, asc, eq, inArray, like, ne, or, sql, type SQL } from 'drizzle-orm';

import { type Principal, type ResourceRef } from '../../platform/authz/can';
import { AuthzService } from '../../platform/authz/authz.service';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { withTx, type TxScope } from '../../platform/db/tx';
import { NumberingService } from '../../platform/settings/numbering.service';
import { CustomersCaller } from './customers.caller';
import {
  escapeLike,
  normalizeEmail,
  normalizeName,
  normalizePan,
  searchTerms,
} from './customers.normalize';
import {
  type CustomerDetailDto,
  type CustomerList,
  type ListCustomersQuery,
} from './customers.types';

type CustomerRow = typeof customers.$inferSelect;
type ContactRow = typeof customerContacts.$inferSelect;
type Q = Db | DbTransaction;

/** Injection token for a test clock; production falls back to the system time. */
export const CUSTOMERS_CLOCK = Symbol('CUSTOMERS_CLOCK');

/** The numbering series key; its prefix is `CUS`, as in CUS-2082/83-00001. */
export const CUSTOMER_SERIES = 'CUS';

const PAN_INDEX = 'customers_tenant_pan_vat_no_unique';
const PRIMARY_CONTACT_INDEX = 'customer_contacts_tenant_customer_primary_unique';

const iso = (d: Date): string => d.toISOString();

const customerNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Customer not found' });

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
    address: row.address as Address,
    mergedIntoId: row.mergedIntoId,
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toContactDto(row: ContactRow): ContactDto {
  return {
    id: row.id,
    customerId: row.customerId,
    fullName: row.fullName,
    email: row.emailNorm,
    phone: row.phoneE164,
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
export function customerRef(row: CustomerRow, p: Principal): ResourceRef {
  return {
    tenantId: row.tenantId,
    organizationId: p.organizationId,
    ownerUserId: row.ownerUserId,
    customerPartyId: row.id,
  };
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
    @Optional() @Inject(CUSTOMERS_CLOCK) private readonly clock: () => Date = () => new Date(),
  ) {}

  // -------------------------------------------------------------------------------------------------- list

  async list(query: ListCustomersQuery): Promise<CustomerList> {
    const { scope, principal } = this.caller.current();
    const conditions: SQL[] = [this.visibleWhere(scope.tenantId, principal, 'customer.read')];
    // A bare constant in ORDER BY is a column position to Postgres, so the rank is added only when it exists.
    const order: SQL[] = [];
    if (query.q !== undefined) {
      const terms = searchTerms(query.q);
      const code = `%${escapeLike(terms.code)}%`;
      const matches: SQL[] = [like(customers.panVatNo, code), like(customers.number, code)];
      if (terms.name !== null) {
        matches.push(like(customers.nameNorm, `%${escapeLike(terms.name)}%`));
        order.push(
          sql`CASE WHEN ${like(customers.nameNorm, `${escapeLike(terms.name)}%`)} THEN 0 ELSE 1 END`,
        );
      }
      conditions.push(or(...matches) as SQL);
    }
    order.push(asc(customers.legalName), asc(customers.id));
    const where = and(...conditions);
    const rows = await this.db
      .select()
      .from(customers)
      .where(where)
      .orderBy(...order)
      .limit(query.limit)
      .offset(query.offset);
    const [count] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(customers)
      .where(where);
    return { items: rows.map(toCustomerDto), total: count?.n ?? 0 };
  }

  // --------------------------------------------------------------------------------------------------- read

  async get(id: string): Promise<CustomerDetailDto> {
    const { scope, principal } = this.caller.current();
    const row = await this.find(this.db, scope.tenantId, id);
    if (row === undefined) throw customerNotFound();
    this.assertVisible('customer.read', row, principal);
    const dto = toCustomerDto(row);
    // The terms are entity-owned: show the ones of the entities this user may act for. A portal caller has
    // no entities, so the field is left out (not an empty list, which would claim "no terms set").
    if (principal.orgKind !== 'staff') return dto;
    return { ...dto, accounts: await this.accountsFor(scope.tenantId, principal.userId, id) };
  }

  // ------------------------------------------------------------------------------------------------- create

  async create(body: CreateCustomerBody, idempotencyKey: string): Promise<CustomerDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'customer.create', key: idempotencyKey, body },
        async () => ({ status: 201, response: await this.createInTx(tx, scope, body, now) }),
      );
      return done.response;
    });
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
    body: CreateCustomerBody,
    now: Date,
  ): Promise<CustomerDto> {
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
          address: body.address,
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
   */
  async update(
    id: string,
    expectedVersion: number,
    fields: Omit<Partial<UpdateCustomerBody>, 'expectedVersion'>,
  ): Promise<CustomerDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    if (Object.values(fields).every((v) => v === undefined)) {
      throw new BadRequestException('at least one field to change is required');
    }
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      // updateVersioned answers 409 for a missing row too, so existence (and tenant) is decided here: 404.
      const row = await this.find(tx, scope.tenantId, id);
      if (row === undefined) throw customerNotFound();
      this.assertVisible('customer.write', row, principal);

      const pan = fields.panVatNo === undefined ? undefined : normalizePan(fields.panVatNo);
      if (pan !== undefined) await this.assertPanFree(tx, scope.tenantId, pan, id);
      if (fields.ownerUserId !== undefined) {
        await this.assertUser(tx, scope.tenantId, fields.ownerUserId);
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
          ...(fields.ownerUserId !== undefined && { ownerUserId: fields.ownerUserId }),
          ...(fields.defaultCurrency !== undefined && { defaultCurrency: fields.defaultCurrency }),
          ...(fields.address !== undefined && { address: fields.address }),
          updatedAt: now,
        });
        if (fields.legalName !== undefined) {
          // The party row carries the same display name; keep the two in step.
          await tx
            .update(parties)
            .set({ name: fields.legalName, updatedAt: now })
            .where(and(eq(parties.tenantId, scope.tenantId), eq(parties.id, id)));
        }
        return toCustomerDto(updated);
      } catch (error) {
        if (pan !== undefined && isUnique(error, PAN_INDEX)) throw duplicatePan(pan);
        throw error;
      }
    });
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
    return rows.map(toContactDto);
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
   * `primary_contact_exists` is answered here, from the unique index).
   */
  async createContactInTx(
    tx: DbTransaction,
    scope: TxScope,
    customerId: string,
    body: CreateContactBody,
    now: Date,
  ): Promise<ContactDto> {
    try {
      const [row] = await tx
        .insert(customerContacts)
        .values({
          tenantId: scope.tenantId,
          customerId,
          fullName: body.fullName,
          emailNorm: body.email === undefined ? null : normalizeEmail(body.email),
          phoneE164: body.phone ?? null,
          title: body.title ?? null,
          isPrimary: body.isPrimary,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      return toContactDto(row!);
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

  /**
   * The customers `p` may `action`, as SQL: the twin of can() for a record that names no entity. `all` is the
   * whole tenant for staff and the caller's own company for a portal user; `own` is the owner column. Anything
   * else (no grant, an unknown scope, an inactive user) matches nothing.
   */
  private visibleWhere(tenantId: string, p: Principal, action: Permission): SQL {
    const none = sql`false`;
    if (p.status !== 'active') return none;
    const inTenant = eq(customers.tenantId, tenantId);
    const ownCompany = (): SQL =>
      p.orgKind === 'customer' && p.partyId !== null && p.partyId !== ''
        ? (and(inTenant, eq(customers.id, p.partyId)) as SQL)
        : none;
    switch (p.grants.get(action)) {
      case 'all':
        return p.orgKind === 'staff' ? inTenant : ownCompany();
      case 'own':
        return and(inTenant, eq(customers.ownerUserId, p.userId)) as SQL;
      case 'customer_org':
        return ownCompany();
      default:
        return none;
    }
  }

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

  /** The owner must be a user of this tenant: say so as a 400 instead of a foreign-key 500. */
  private async assertUser(tx: DbTransaction, tenantId: string, userId: string): Promise<void> {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, userId)))
      .limit(1);
    if (user === undefined) {
      throw new BadRequestException({
        code: 'bad_request',
        message: 'ownerUserId is not a user of this tenant',
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

  /** The terms of customer `id` with the entities `userId` may act for (user_entities). */
  private async accountsFor(
    tenantId: string,
    userId: string,
    id: string,
  ): Promise<PartyAccountDto[]> {
    const rows = await this.db
      .select()
      .from(partyAccounts)
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
    return rows.map((r) => ({
      partyId: r.partyId,
      organizationId: r.organizationId,
      paymentTermId: r.paymentTermId,
      creditLimit: r.creditLimit,
      version: r.version,
    }));
  }
}
