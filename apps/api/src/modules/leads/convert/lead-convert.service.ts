// LeadConvertService: turns a qualified lead into a customer (new or existing), a contact with an email and an
// opportunity, in one transaction. Serves the NFRs:
// - "no double effects": the Idempotency-Key is required (command `lead.convert`, the hashed body includes the lead
//   id), and the lead row is locked, so two converts of one lead cannot both pass the stage guard;
// - "no lost updates": the caller names the version it saw, and the lead moves with updateVersioned();
// - "no gaps in a numbered series": the CUS number comes from the default entity inside createInTx, the DEAL number
//   from the acting entity, both inside this transaction, so a refusal leaves no hole;
// - "the pipeline is auditable": the lead.converted event carries the override reason, and the lead gets a
//   stage_change activity;
// - "authorization is deny-by-default": a lead outside the caller's entity or scope is a 404; creating a customer
//   needs customer.write and linking an existing one needs customer.read, checked on the record.
// A possible duplicate is a 409 the caller can override with a reason, except a PAN/VAT match, which never can.
// Countries and phones (FX9): the new customer and contact carry the country the body names (the form fills it from
// the lead, whose country is explicit, so nothing is guessed here). A new contact sent without phone numbers gets
// copies of the lead's numbers, each with its own country; those copies are checked for duplicates like typed ones.
import {
  type ConvertLeadBody,
  type ContactDto,
  type CreateContactBody,
  type CustomerFields,
  type PartyPhoneInput,
  type Permission,
} from '@bos/contracts';
import {
  activities,
  customerContactPhones,
  customerContacts,
  customers,
  leads,
  opportunities,
  scoped,
} from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService } from '../../../platform/authz/authz.service';
import { can, type Principal, type ResourceRef } from '../../../platform/authz/can';
import { RoleCache } from '../../../platform/authz/role-cache';
import { DB, type Db } from '../../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type DbTransaction, type TxScope } from '../../../platform/db/tx';
import { NumberingService } from '../../../platform/settings/numbering.service';
import {
  contactEmailRequired,
  customerRef,
  CustomersService,
  duplicatePan,
} from '../../customers/customers.service';
import { carryOpenFollowUps } from '../../activities/follow-ups';
import { customerVisibleWhere } from '../../customers/customer-read-scope';
import { normalizeEmail, normalizeName, normalizePan } from '../../customers/customers.normalize';
import { loadAssignmentParties, partyHolds } from '../lead-assignee';
import { loadPhonesOfLead } from '../lead-phones';
import { LeadsCaller } from '../leads.caller';
import { type LeadRow } from '../leads.types';
import { leadRef } from '../leads.service';
import { mergeCandidates, planConvert, type Candidate } from './convert.rules';

const AUDIT_ENTITY = 'leads';

/** The numbering series key of an opportunity; NumberingService formats it like DEAL-2082/83-00001. */
export const OPPORTUNITY_SERIES = 'DEAL';

/** Most rows one duplicate query reads: two kinds of at most 20 stay inside the 50 the wire allows. */
const DUPLICATE_LIMIT = 20;

export interface ConvertLeadResult {
  opportunityId: string;
  customerId: string;
}

type CustomerChoice = ConvertLeadBody['customer'];
type CustomerRow = typeof customers.$inferSelect;

const leadNotFound = () => new NotFoundException({ code: 'not_found', message: 'Lead not found' });
const customerNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Customer not found' });

@Injectable()
export class LeadConvertService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly numbering: NumberingService,
    private readonly customersService: CustomersService,
    private readonly caller: LeadsCaller,
    private readonly roleCache: RoleCache,
  ) {}

  async convert(
    id: string,
    body: ConvertLeadBody,
    idempotencyKey: string,
  ): Promise<ConvertLeadResult> {
    const { scope, actor, principal } = this.caller.current();
    const now = new Date();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency<ConvertLeadResult>(
        tx,
        { command: 'lead.convert', key: idempotencyKey, body: { leadId: id, ...body } },
        async () => ({
          status: 201,
          response: await this.run(tx, scope, principal, id, body, now),
        }),
      );
      return done.response;
    });
  }

  private async run(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    id: string,
    body: ConvertLeadBody,
    now: Date,
  ): Promise<ConvertLeadResult> {
    // 1. The lead: its entity first (404), then the caller's scope (404), then its state (409).
    const lead = await this.lock(tx, scope, id);
    this.assertLeadVisible(lead);
    const plan = planConvert({
      stage: lead.stage,
      version: lead.version,
      expectedVersion: body.expectedVersion,
    });
    if (!plan.ok) throw new ConflictException({ code: 'conflict', message: plan.message });

    // 2. The customer the lead becomes: checked before anything is written.
    const choice = body.customer;
    const existing =
      choice.mode === 'existing'
        ? await this.loadExisting(tx, principal, scope, choice)
        : undefined;
    if (choice.mode === 'create') this.assertMayCreateCustomer(principal, scope, choice.customer);
    const contactChoice = body.contact;
    if (contactChoice.mode === 'existing' && existing === undefined) {
      throw new BadRequestException({
        code: 'bad_request',
        message: 'An existing contact needs an existing customer',
      });
    }
    if (contactChoice.mode === 'create' && existing !== undefined) {
      // A contact is customer data: reading the customer is not enough to add one (extra to the brief, named).
      this.assertCustomerVisible('customer.write', existing, principal);
    }
    if (contactChoice.mode === 'existing' && existing !== undefined) {
      await this.assertContactBelongs(tx, scope, existing.id, contactChoice.contactId);
    }
    // A new contact without numbers takes copies of the lead's (primary first, then their saved order).
    const newContact: CreateContactBody | undefined =
      contactChoice.mode === 'create'
        ? await this.withLeadPhones(tx, scope, lead.id, contactChoice.contact)
        : undefined;

    // 3. Duplicates. A PAN/VAT match is refused first and whatever the override says; the rest is a warning.
    if (choice.mode === 'create') await this.assertPanFree(tx, scope, choice.customer);
    if (body.duplicateOverride === undefined) {
      const duplicates = await this.findDuplicates(tx, scope, principal, choice, newContact);
      if (duplicates.length > 0) {
        throw new ConflictException({
          code: 'duplicate_found',
          message: 'This looks like a customer or contact that already exists',
          duplicates,
        });
      }
    }

    // 4. Customer and contact.
    const customerId =
      choice.mode === 'create'
        ? (await this.customersService.createInTx(tx, scope, choice.customer, now)).id
        : choice.customerId;
    let contactId: string | null = null;
    let createdContact: ContactDto | undefined;
    if (contactChoice.mode === 'existing') contactId = contactChoice.contactId;
    if (newContact !== undefined) {
      createdContact = await this.customersService.createContactInTx(
        tx,
        scope,
        customerId,
        newContact,
        now,
      );
      contactId = createdContact.id;
    }

    // 5. The opportunity, numbered from the acting entity's DEAL series (createInTx put the acting entity back).
    const { number } = await this.numbering.issue(tx, OPPORTUNITY_SERIES, now);
    const [opportunity] = await tx
      .insert(opportunities)
      .values({
        ...scope,
        number,
        name: body.opportunityName,
        customerId,
        contactId,
        leadId: lead.id,
        ownerUserId: lead.ownerUserId,
        // FX-Q1: whoever entered the lead keeps reading the deal it becomes and may draft its quotations.
        leadCreatorUserId: lead.createdByUserId,
        stage: 'qualified',
        value: lead.expectedValue,
        currency: lead.currency,
        probability: lead.probability,
        expectedClose: lead.expectedClose,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: opportunities.id });
    const opportunityId = opportunity!.id;

    // U16-Q6: the lead's open follow-ups go on with the deal, same assignee, due time and text, when the assignee
    // can open deals at all (their live grants hold crm.opportunity.read at any scope; an assigned follow-up is
    // then enough to reach this one).
    await carryOpenFollowUps(tx, scope, this.audit, {
      leadId: lead.id,
      opportunityId,
      canWorkOn: async (userIds) => {
        const parties = await loadAssignmentParties(tx, scope, userIds);
        const workers = new Set<string>();
        for (const party of parties) {
          if (await partyHolds(this.roleCache, scope, party, 'crm.opportunity.read')) {
            workers.add(party.userId);
          }
        }
        return workers;
      },
    });

    // 6. The lead, audit and activity.
    const updated = await updateVersioned(tx, leads, lead.id, body.expectedVersion, {
      stage: 'converted',
      stageReason: null,
      stageNote: null,
      customerId,
      contactId,
      convertedOpportunityId: opportunityId,
      updatedAt: now,
    });
    await this.audit.record(tx, {
      action: 'lead.converted',
      entityType: AUDIT_ENTITY,
      entityId: lead.id,
      before: { stage: lead.stage, version: lead.version },
      after: {
        stage: updated.stage,
        version: updated.version,
        customerId,
        contactId,
        opportunityId,
      },
      meta: {
        opportunityNumber: number,
        customerMode: choice.mode,
        contactMode: contactChoice.mode,
        ...(body.duplicateOverride === undefined
          ? {}
          : { duplicateOverrideReason: body.duplicateOverride.reason }),
      },
    });
    await tx.insert(activities).values({
      ...scope,
      kind: 'stage_change',
      subject: `Stage changed from ${lead.stage} to ${updated.stage}`,
      body: `Converted to opportunity ${number}`,
      leadId: lead.id,
      createdByUserId: principal.userId,
    });
    return { opportunityId, customerId };
  }

  // ----------------------------------------------------------------------------------------------- helpers

  /** The lead row of this entity, locked until the transaction ends. */
  private async lock(tx: DbTransaction, scope: TxScope, id: string): Promise<LeadRow> {
    const [row] = await tx
      .select()
      .from(leads)
      .where(scoped(scope).where(leads, eq(leads.id, id)))
      .for('update');
    if (row === undefined) throw leadNotFound();
    return row;
  }

  /** 404, not 403, for a lead outside the caller's scope: a 403 would confirm that a guessed id exists. */
  private assertLeadVisible(row: LeadRow): void {
    try {
      this.authz.assert('crm.lead.write', leadRef(row));
    } catch (error) {
      if (reasonOf(error) === 'out_of_scope') throw leadNotFound();
      throw error;
    }
  }

  /** 404 for a customer outside the caller's scope, as CustomersService answers it. */
  private assertCustomerVisible(action: Permission, row: CustomerRow, p: Principal): void {
    try {
      this.authz.assert(action, customerRef(row, p));
    } catch (error) {
      if (reasonOf(error) === 'out_of_scope') throw customerNotFound();
      throw error;
    }
  }

  /** A new customer needs customer.write; customers are written by staff only, as in CustomersService. */
  private assertMayCreateCustomer(p: Principal, scope: TxScope, body: CustomerFields): void {
    if (p.orgKind !== 'staff') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
    }
    // The owner the row will get (createInTx stores the caller when the body names none), so an `own` grant agrees.
    const ref: ResourceRef = {
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      ownerUserId: body.ownerUserId ?? null,
    };
    this.authz.assert('customer.write', ref);
    // Naming someone else as the owner is an owner change, as on POST /v1/customers (R4c2 Q5a/Q6b).
    if (body.ownerUserId !== undefined && body.ownerUserId !== p.userId) {
      this.authz.assert('customers.owner.write', {
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
      });
    }
  }

  /** An existing customer: of this tenant (404), readable by the caller (404 when out of scope), not merged (409). */
  private async loadExisting(
    tx: DbTransaction,
    p: Principal,
    scope: TxScope,
    choice: Extract<CustomerChoice, { mode: 'existing' }>,
  ): Promise<CustomerRow> {
    const [row] = await tx
      .select()
      .from(customers)
      .where(and(eq(customers.tenantId, scope.tenantId), eq(customers.id, choice.customerId)));
    if (row === undefined) throw customerNotFound();
    this.assertCustomerVisible('customer.read', row, p);
    if (row.mergedIntoId !== null) {
      throw new ConflictException({
        code: 'conflict',
        message: 'This customer was merged into another one; convert to that customer instead',
      });
    }
    return row;
  }

  /** The contact must belong to the chosen customer: say so as a 400 instead of a foreign-key 500. */
  private async assertContactBelongs(
    tx: DbTransaction,
    scope: TxScope,
    customerId: string,
    contactId: string,
  ): Promise<void> {
    const [row] = await tx
      .select({ id: customerContacts.id, emailNorm: customerContacts.emailNorm })
      .from(customerContacts)
      .where(
        and(
          eq(customerContacts.tenantId, scope.tenantId),
          eq(customerContacts.customerId, customerId),
          eq(customerContacts.id, contactId),
        ),
      );
    if (row === undefined) {
      throw new BadRequestException({
        code: 'bad_request',
        message: 'contactId is not a contact of this customer',
      });
    }
    // The opportunity's quotations go to this contact by email, so one without an address cannot be linked.
    if (row.emailNorm === null) throw contactEmailRequired();
  }

  /**
   * The new contact as it will be written. A body that sends a phone list keeps it, an empty one included: the user
   * removed the lead's numbers, so the contact gets none. Only a body that leaves `phones` out takes copies of the
   * lead's numbers (country, number, label and primary mark; the contact's own rows get their own sort order).
   */
  private async withLeadPhones(
    tx: DbTransaction,
    scope: TxScope,
    leadId: string,
    contact: Extract<ConvertLeadBody['contact'], { mode: 'create' }>['contact'],
  ): Promise<CreateContactBody> {
    if (contact.phones !== undefined) return { ...contact, phones: contact.phones };
    const phones: PartyPhoneInput[] = (await loadPhonesOfLead(tx, scope, leadId)).map((phone) => ({
      country: phone.country,
      e164: phone.e164,
      label: phone.label ?? null,
      isPrimary: phone.isPrimary,
    }));
    return { ...contact, phones };
  }

  /** 409 `duplicate_pan_vat`, whatever the override says: the unique index would refuse the insert anyway. */
  private async assertPanFree(
    tx: DbTransaction,
    scope: TxScope,
    body: CustomerFields,
  ): Promise<void> {
    if (body.panVatNo === undefined) return;
    const pan = normalizePan(body.panVatNo);
    const [match] = await tx
      .select({ id: customers.id, number: customers.number })
      .from(customers)
      .where(and(eq(customers.tenantId, scope.tenantId), eq(customers.panVatNo, pan)))
      .limit(1);
    if (match !== undefined) throw duplicatePan(pan, match);
  }

  /**
   * The customers with the same normalised name (only for a new customer; merged ones are not live records) and
   * the contacts with the same e-mail or with any number equal to any of the new contact's numbers (only for a new
   * contact), across the tenant. A phone match is one EXISTS per contact, so a contact sharing two numbers is still
   * one row of the limit.
   * Only customers the caller may read (FX9 A1): customerVisibleWhere (the customers list's SQL twin of can()) sits
   * in the same WHERE as each LIMIT, as in the lead duplicate hint, so a customer or a contact of a customer the
   * caller cannot open is never named in `duplicate_found` and never takes a slot; can() re-checks each row.
   */
  private async findDuplicates(
    tx: DbTransaction,
    scope: TxScope,
    principal: Principal,
    choice: CustomerChoice,
    contact: CreateContactBody | undefined,
  ): Promise<Candidate[]> {
    const found: Candidate[] = [];
    const visible = customerVisibleWhere(principal, customers, 'customer.read', scope.tenantId);
    const readable = (r: Pick<CustomerRow, 'tenantId' | 'id' | 'ownerUserId'>) =>
      can(principal, 'customer.read', customerRef(r, principal)).allowed;
    if (choice.mode === 'create') {
      const rows = await tx
        .select({
          id: customers.id,
          tenantId: customers.tenantId,
          ownerUserId: customers.ownerUserId,
          number: customers.number,
          legalName: customers.legalName,
        })
        .from(customers)
        .where(
          and(
            eq(customers.tenantId, scope.tenantId),
            eq(customers.nameNorm, normalizeName(choice.customer.legalName)),
            isNull(customers.mergedIntoId),
            visible,
          ),
        )
        .orderBy(asc(customers.number), asc(customers.id))
        .limit(DUPLICATE_LIMIT);
      for (const r of rows.filter(readable)) {
        found.push({
          kind: 'customer',
          id: r.id,
          label: `${r.legalName} (${r.number})`,
          matchedOn: 'name',
        });
      }
    }
    if (contact !== undefined) {
      const email = contact.email === undefined ? undefined : normalizeEmail(contact.email);
      const numbers = [...new Set(contact.phones.map((p) => p.e164))];
      const samePhone =
        numbers.length === 0
          ? undefined
          : sql`EXISTS (SELECT 1 FROM ${customerContactPhones} WHERE ${customerContactPhones.tenantId} = ${
              customerContacts.tenantId
            } AND ${customerContactPhones.contactId} = ${customerContacts.id} AND ${inArray(
              customerContactPhones.e164,
              numbers,
            )})`;
      const matches: SQL[] = [];
      if (email !== undefined) matches.push(eq(customerContacts.emailNorm, email));
      if (samePhone !== undefined) matches.push(samePhone);
      if (matches.length > 0) {
        const rows = await tx
          .select({
            id: customerContacts.id,
            customerId: customerContacts.customerId,
            fullName: customerContacts.fullName,
            emailNorm: customerContacts.emailNorm,
            phoneMatch:
              samePhone === undefined
                ? sql<boolean>`false`
                : sql<boolean>`coalesce(${samePhone}, false)`,
            legalName: customers.legalName,
            tenantId: customers.tenantId,
            ownerUserId: customers.ownerUserId,
          })
          .from(customerContacts)
          .innerJoin(
            customers,
            and(
              eq(customers.tenantId, customerContacts.tenantId),
              eq(customers.id, customerContacts.customerId),
            ),
          )
          .where(and(eq(customerContacts.tenantId, scope.tenantId), visible, or(...matches)))
          .orderBy(asc(customerContacts.fullName), asc(customerContacts.id))
          .limit(DUPLICATE_LIMIT);
        for (const r of rows) {
          if (!readable({ tenantId: r.tenantId, id: r.customerId, ownerUserId: r.ownerUserId })) {
            continue;
          }
          const base = {
            kind: 'contact' as const,
            id: r.id,
            label: `${r.fullName} (${r.legalName})`,
            customerId: r.customerId,
          };
          if (email !== undefined && r.emailNorm === email) {
            found.push({ ...base, matchedOn: 'email' });
          }
          if (r.phoneMatch) {
            found.push({ ...base, matchedOn: 'phone' });
          }
        }
      }
    }
    return mergeCandidates(found);
  }
}

/** The authz denial reason of a ForbiddenException, if that is what `error` is. */
function reasonOf(error: unknown): unknown {
  return error instanceof ForbiddenException
    ? (error.getResponse() as { reason?: unknown }).reason
    : undefined;
}
