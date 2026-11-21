// VendorsService: the tenant-level vendor records, their contacts and their per-entity accounts (ADR 0027, AD15).
// Serves the NFRs:
// - "every change is audited": every write runs in withTx(), so the audit triggers of parties, vendors,
//   vendor_contacts and vendor_accounts record the actor and the acting entity; a lifecycle move also writes a
//   domain event that carries the reason;
// - "no double effects" and "no lost updates": every POST takes an Idempotency-Key, a PATCH carries
//   expectedVersion and goes through updateVersioned(), and a lifecycle move locks the vendor row first;
// - "separation of duties": the vendor's creator cannot activate it (403 here, and the vendors_approved_by_check
//   CHECK is the backstop); an activation also needs the vendor's KYB case to be approved (409);
// - "authorization is deny-by-default": a vendor has no organization_id, so every query filters the tenant by
//   hand and the caller's grant scope is applied by visibleWhere() (the twin of can() for a record without an
//   entity); the entity-owned vendor_accounts follow the acting entity, so another entity's account is a 404.
import {
  type CreateVendorBody,
  type Permission,
  type VendorAccountDto,
  type VendorCapabilities,
  type VendorContactBody,
  type VendorDto,
  type VendorStatus,
} from '@bos/contracts';
import {
  parties,
  paymentTerms,
  userEntities,
  users,
  vendorAccounts,
  vendorContacts,
  vendors,
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
import { and, asc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can, type Principal, type ResourceRef } from '../../platform/authz/can';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { withTx } from '../../platform/db/tx';
import { searchPage } from '../../platform/list';
import { normalizeEmail } from '../customers/customers.normalize';
import { VerificationService } from '../verification/verification.service';
import { VendorsCaller } from './vendors.caller';
import { kybCaseOf, lockVendor, type VendorRow } from './vendors.queries';
import {
  isoDay,
  kindCountryProblem,
  kybReadyForReview,
  kindFromRow,
  kindToRow,
  lapsedTaxClearance,
  LIFECYCLE,
  lifecycleAllowed,
  sameNameVendors,
  submitKycMove,
  vendorPartyCode,
  type LifecycleCommand,
} from './vendors.rules';
import {
  type CreateVendorAccountBody,
  type ListVendorsQuery,
  type UpdateVendorBody,
  type UpdateVendorContactBody,
  type VendorContactDto,
  type VendorList,
  type VendorNameMatches,
  type VendorNameMatchesQuery,
  type VendorReviewReadiness,
} from './vendors.types';

type ContactRow = typeof vendorContacts.$inferSelect;
type AccountRow = typeof vendorAccounts.$inferSelect;
type Q = Db | DbTransaction;

/** Injection token for a test clock; production falls back to the system time. */
export const VENDORS_CLOCK = Symbol('VENDORS_CLOCK');

const PAN_INDEX = 'vendors_tenant_pan_unique';
const PRIMARY_CONTACT_INDEX = 'vendor_contacts_tenant_vendor_primary_unique';
const ACCOUNT_UNIQUE = 'vendor_accounts_tenant_org_vendor_unique';

/** Most vendors one name-match answer lists: enough to recognise the record, small enough to read. */
const NAME_MATCH_LIMIT = 20;

const vendorNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Vendor not found' });

export interface VendorKybGate {
  approved: boolean;
  kycExpired: boolean;
}

/**
 * What `principal` may do on `row` now, by the same live grants, lifecycle transitions, creator SoD,
 * and KYB/tax-clearance rules the service enforces. Pure, so screens and tests need no database.
 */
export function vendorCapabilities(
  principal: Principal,
  row: Pick<VendorRow, 'id' | 'tenantId' | 'ownerUserId' | 'createdBy' | 'status'>,
  kyb?: VendorKybGate,
): VendorCapabilities {
  const isStaff = principal.orgKind === 'staff';
  const ref = vendorRef(row, principal);
  const mutable = row.status !== 'blocked' && row.status !== 'archived';
  const mayWrite = isStaff && mutable && can(principal, 'vendor.write', ref).allowed;
  const mayActivate = isStaff && can(principal, 'vendor.activate', ref).allowed;
  const isCreator = row.createdBy !== null && row.createdBy === principal.userId;
  const canActivateStatus = lifecycleAllowed('activate', row.status);
  const eligibleActivate = canActivateStatus && mayActivate && !isCreator;
  const kybBlocked = eligibleActivate && kyb !== undefined && !kyb.approved;
  const kycExpiredBlocked = eligibleActivate && kyb !== undefined && kyb.approved && kyb.kycExpired;
  return {
    write: mayWrite,
    activate: eligibleActivate && !kybBlocked && !kycExpiredBlocked,
    suspend: lifecycleAllowed('suspend', row.status) && mayActivate,
    block: lifecycleAllowed('block', row.status) && mayActivate,
    archive: lifecycleAllowed('archive', row.status) && mayActivate,
    activateBlockedBySod: canActivateStatus && mayActivate && isCreator,
    ...(kyb !== undefined
      ? {
          activateBlockedByKyb: kybBlocked,
          activateBlockedByKycExpired: kycExpiredBlocked,
        }
      : {}),
    proposeBank: isStaff && mutable && can(principal, 'vendor.bank.propose', ref).allowed,
    verifyBank: isStaff && can(principal, 'vendor.bank.verify', ref).allowed,
  };
}

export function toVendorDto(row: VendorRow, principal?: Principal, kyb?: VendorKybGate): VendorDto {
  return {
    id: row.id,
    legalName: row.legalName,
    // No column yet for the trade name or the approval time (0032 has neither): reported to the lead.
    tradeName: null,
    kind: kindFromRow(row.kind),
    pan: row.pan,
    vatRegistered: row.vatRegistered,
    country: row.country,
    status: row.status,
    version: row.version,
    approvedAt: null,
    logoDocumentId: row.logoDocumentId,
    ...(principal === undefined ? {} : { can: vendorCapabilities(principal, row, kyb) }),
  };
}

export function toContactDto(row: ContactRow): VendorContactDto {
  return {
    id: row.id,
    vendorPartyId: row.vendorId,
    name: row.fullName,
    email: row.emailNorm,
    phone: row.phoneE164,
    role: row.title,
    isPrimary: row.isPrimary,
    version: row.version,
  };
}

export function toAccountDto(row: AccountRow, netDays: number | null): VendorAccountDto {
  return {
    vendorPartyId: row.vendorId,
    organizationId: row.organizationId,
    paymentTermsDays: netDays ?? 0,
    defaultCurrency: (row.defaultCurrency ?? 'NPR') as VendorAccountDto['defaultCurrency'],
    defaultWithholdingCodeId: row.defaultWithholdingCodeId,
    active: row.active,
  };
}

/**
 * What authz decides on for one vendor. A vendor is tenant-level, so the entity of the ref is the caller's acting
 * entity (every entity of the tenant sees every vendor); `vendorPartyId` is the vendor's own party id.
 */
export function vendorRef(
  row: Pick<VendorRow, 'id' | 'tenantId' | 'ownerUserId'>,
  p: Principal,
): ResourceRef {
  return {
    tenantId: row.tenantId,
    organizationId: p.organizationId,
    ownerUserId: row.ownerUserId,
    vendorPartyId: row.id,
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

const duplicatePan = (pan: string, existingId?: string) =>
  new ConflictException({
    // An existing code of the error filter, so clients can switch on it (the customers module uses it too).
    code: 'duplicate_pan_vat',
    message: `A vendor with PAN ${pan} already exists`,
    ...(existingId === undefined ? {} : { details: { vendorId: existingId } }),
  });

/** A stale button is plain `conflict` (as a stale lead stage move); a status that takes no KYC move is a transition. */
const submitKycRefusal = (kind: 'stale' | 'invalid', message: string) =>
  new ConflictException({ code: kind === 'stale' ? 'conflict' : 'invalid_transition', message });

const invalidTransition = (command: LifecycleCommand, from: VendorStatus) =>
  new ConflictException({
    code: 'invalid_transition',
    message: `A vendor in status ${from} cannot be moved to ${LIFECYCLE[command].to}`,
  });

@Injectable()
export class VendorsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly caller: VendorsCaller,
    private readonly verification: VerificationService,
    private readonly audit: AuditService,
    @Optional() @Inject(VENDORS_CLOCK) private readonly clock: () => Date = () => new Date(),
  ) {}

  // -------------------------------------------------------------------------------------------------- list

  async list(query: ListVendorsQuery): Promise<VendorList> {
    const { scope, principal } = this.caller.current();
    // Scope and filters are one `where`; searchPage ANDs the search onto it, so a close match never widens access.
    const where = and(
      this.visibleWhere(scope.tenantId, principal, 'vendor.read'),
      query.status === undefined ? undefined : inArray(vendors.status, query.status),
      // The table says `proprietor` where the API says `sole_proprietor`.
      query.kind === undefined ? undefined : inArray(vendors.kind, query.kind.map(kindToRow)),
    );
    const { rows, total } = await searchPage(this.db, {
      q: query.q,
      columns: [vendors.legalName, vendors.pan],
      where,
      orderBy: [asc(vendors.legalName), asc(vendors.id)],
      limit: query.limit,
      offset: query.offset,
      rows: (tx, p) =>
        tx
          .select()
          .from(vendors)
          .where(p.where)
          .orderBy(...p.orderBy)
          .limit(p.limit)
          .offset(p.offset),
      count: async (tx, w) => {
        const [count] = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(vendors)
          .where(w);
        return count?.n ?? 0;
      },
    });
    return { items: rows.map((row) => toVendorDto(row, principal)), total };
  }

  // --------------------------------------------------------------------------------------------------- read

  async get(id: string): Promise<VendorDto> {
    const { scope, principal } = this.caller.current();
    const row = await this.find(this.db, scope.tenantId, id);
    if (row === undefined) throw vendorNotFound();
    this.assertVisible('vendor.read', row, principal);
    if (!lifecycleAllowed('activate', row.status)) {
      return toVendorDto(row, principal);
    }
    const kyb = await kybCaseOf(this.db, scope.tenantId, id);
    const approved = kyb?.status === 'approved';
    const kycExpired = approved ? lapsedTaxClearance(kyb.items, isoDay(this.clock())) : false;
    return toVendorDto(row, principal, { approved, kycExpired });
  }

  /**
   * The vendors the caller may read whose legal name matches `legalName` (vendorNameKey), every status included:
   * a blocked or archived namesake is the case the warning is for. A warning only (TR-Q12d): create never refuses.
   * The key is worked out here, not in SQL (the table has no name key), over the tenant's id, name and status.
   */
  async nameMatches(query: VendorNameMatchesQuery): Promise<VendorNameMatches> {
    const { scope, principal } = this.caller.current();
    this.assertStaff(principal);
    const rows = await this.db
      .select({ id: vendors.id, legalName: vendors.legalName, status: vendors.status })
      .from(vendors)
      .where(this.visibleWhere(scope.tenantId, principal, 'vendor.read'))
      .orderBy(asc(vendors.legalName), asc(vendors.id));
    return { matches: sameNameVendors(query.legalName, rows).slice(0, NAME_MATCH_LIMIT) };
  }

  /**
   * Whether the vendor's KYB case is submitted or approved: the same check `submitKyc` makes before pending_kyc ->
   * under_review, so "Send for review" is drawn only when the API would take it. Needs `vendor.read` on the vendor.
   */
  async reviewReadiness(id: string): Promise<VendorReviewReadiness> {
    const { scope, principal } = this.caller.current();
    this.assertStaff(principal);
    const row = await this.find(this.db, scope.tenantId, id);
    if (row === undefined) throw vendorNotFound();
    this.assertVisible('vendor.read', row, principal);
    const kyb = await kybCaseOf(this.db, scope.tenantId, id);
    return { kybSubmitted: kybReadyForReview(kyb?.status) };
  }

  // ------------------------------------------------------------------------------------------------- create

  /**
   * Party (kind vendor), then vendor, then the vendor's account in the acting entity, in one transaction. A PAN
   * another vendor of the tenant holds is 409 `duplicate_pan`; a kind and country that contradict are 400.
   */
  async create(body: CreateVendorBody, idempotencyKey: string): Promise<VendorDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    this.authz.assert('vendor.write');
    const problem = kindCountryProblem(body.kind, body.country);
    if (problem !== undefined)
      throw new BadRequestException({ code: 'bad_request', message: problem });
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'vendor.create', key: idempotencyKey, body },
        async () => ({ status: 201, response: await this.createInTx(tx, body, now) }),
      );
      return done.response;
    });
  }

  /**
   * The vendor insert of create(), inside a transaction that withTx opened for the caller's scope: the PAN pre-check,
   * the party and vendors rows (status `draft`, so an unverified vendor like a hand-created one), the account with the
   * acting entity, the same-name audit note and, when given, the first contact. It has no idempotency and no caller
   * checks and does not look at the kind and country pairing (create() does); the caller of this method decides who
   * may write. The CSV import (round 5, K1) calls it once per row inside its own batch transaction.
   */
  async createInTx(
    tx: DbTransaction,
    body: CreateVendorBody,
    now: Date,
    contact?: { name: string; email?: string; phone?: string },
  ): Promise<VendorDto> {
    const { scope, actor, principal } = this.caller.current();
    const pan = body.pan ?? null;
    if (pan !== null) await this.assertPanFree(tx, scope.tenantId, pan);
    const id = randomUUID();
    try {
      await tx.insert(parties).values({
        id,
        tenantId: scope.tenantId,
        kind: 'vendor',
        code: vendorPartyCode(id),
        name: body.legalName,
        createdAt: now,
        updatedAt: now,
      });
      const [row] = await tx
        .insert(vendors)
        .values({
          id,
          tenantId: scope.tenantId,
          legalName: body.legalName,
          kind: kindToRow(body.kind),
          pan,
          vatRegistered: body.vatRegistered,
          country: body.country,
          status: 'draft',
          ownerUserId: actor.id,
          createdBy: actor.id,
          version: 1,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      await tx.insert(vendorAccounts).values({
        tenantId: scope.tenantId,
        organizationId: scope.organizationId,
        vendorId: id,
        defaultCurrency: 'NPR',
        active: true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      });
      await this.recordSameName(tx, scope.tenantId, id, body.legalName);
      if (contact !== undefined) {
        await tx.insert(vendorContacts).values({
          tenantId: scope.tenantId,
          vendorId: id,
          fullName: contact.name,
          emailNorm: contact.email === undefined ? null : normalizeEmail(contact.email),
          phoneE164: contact.phone ?? null,
          title: null,
          isPrimary: true,
          version: 1,
          createdAt: now,
          updatedAt: now,
        });
      }
      return toVendorDto(row!, principal);
    } catch (error) {
      // Two creates with the same PAN can both pass the pre-check; the unique index decides.
      if (pan !== null && isUnique(error, PAN_INDEX)) throw duplicatePan(pan);
      throw error;
    }
  }

  // ------------------------------------------------------------------------------------------------ update

  /** `fields` holds only what the client sent. 404 for a vendor of another tenant; stale version is 409. */
  async update(
    id: string,
    expectedVersion: number,
    fields: Omit<Partial<UpdateVendorBody>, 'expectedVersion'>,
  ): Promise<VendorDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    if (Object.values(fields).every((v) => v === undefined)) {
      throw new BadRequestException('at least one field to change is required');
    }
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const row = await this.find(tx, scope.tenantId, id);
      if (row === undefined) throw vendorNotFound();
      this.assertVisible('vendor.write', row, principal);
      if (row.status === 'archived' || row.status === 'blocked') {
        throw new ConflictException({
          code: 'vendor_not_editable',
          message: `A ${row.status} vendor cannot be edited`,
        });
      }
      if (
        (fields.legalName !== undefined || fields.pan !== undefined) &&
        (row.status === 'approved' || row.status === 'suspended')
      ) {
        throw new ConflictException({
          code: 'vendor_identity_locked',
          message: 'The legal name and PAN of an approved vendor change through a new KYB review',
        });
      }
      if (fields.pan !== undefined) {
        if (row.kind === 'foreign') {
          throw new BadRequestException({
            code: 'bad_request',
            message: 'A foreign vendor has no Nepali PAN',
          });
        }
        await this.assertPanFree(tx, scope.tenantId, fields.pan, id);
      }
      if (fields.ownerUserId !== undefined) {
        await this.assertUser(tx, scope.tenantId, fields.ownerUserId);
      }
      try {
        const updated = await updateVersioned(tx, vendors, id, expectedVersion, {
          ...(fields.legalName !== undefined && { legalName: fields.legalName }),
          ...(fields.pan !== undefined && { pan: fields.pan }),
          ...(fields.vatRegistered !== undefined && { vatRegistered: fields.vatRegistered }),
          ...(fields.ownerUserId !== undefined && { ownerUserId: fields.ownerUserId }),
          updatedAt: now,
        });
        if (fields.legalName !== undefined) {
          await tx
            .update(parties)
            .set({ name: fields.legalName, updatedAt: now })
            .where(and(eq(parties.tenantId, scope.tenantId), eq(parties.id, id)));
        }
        return toVendorDto(updated, principal);
      } catch (error) {
        if (fields.pan !== undefined && isUnique(error, PAN_INDEX)) throw duplicatePan(fields.pan);
        throw error;
      }
    });
  }

  // ---------------------------------------------------------------------------------------------- lifecycle

  /**
   * draft -> pending_kyc: opens the vendor's KYB case through VerificationService (so the registered vendor
   * adapter and `vendor.write` decide), then moves the vendor. pending_kyc -> under_review: only once that case is
   * submitted or approved (409 `kyb_not_submitted` otherwise). The case opens in its own transaction, before the
   * vendor's: opening is idempotent, so a retry after a failed move is harmless. `expectedStatus` (the status the
   * caller's button was drawn for) is checked under the row lock: a different status is a 409, so a stale
   * "Start KYB review" never runs "Send for review".
   */
  async submitKyc(
    id: string,
    idempotencyKey: string,
    expectedStatus?: VendorStatus,
  ): Promise<VendorDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    const before = await this.find(this.db, scope.tenantId, id);
    if (before === undefined) throw vendorNotFound();
    this.assertVisible('vendor.write', before, principal);
    // Only the statuses that take no KYC move are refused before the case opens. The expected status is checked
    // under the lock, inside withIdempotency, so a retry of a request that already moved the vendor still replays
    // its first answer; opening the case for a stale button is harmless (it is idempotent).
    const early = submitKycMove(before.status, undefined);
    if (!early.ok) throw submitKycRefusal(early.kind, early.message);
    await this.verification.create({ partyId: id });
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        {
          command: 'vendor.submit_kyc',
          key: idempotencyKey,
          body: { id, expectedStatus: expectedStatus ?? null },
        },
        async () => {
          const row = await lockVendor(tx, scope.tenantId, id);
          if (row === undefined) throw vendorNotFound();
          const move = submitKycMove(row.status, expectedStatus);
          if (!move.ok) throw submitKycRefusal(move.kind, move.message);
          const to: VendorStatus = move.to;
          if (to === 'under_review') {
            const kyb = await kybCaseOf(tx, scope.tenantId, id);
            if (!kybReadyForReview(kyb?.status)) {
              throw new ConflictException({
                code: 'kyb_not_submitted',
                message: 'The KYB case must be submitted before the vendor goes under review',
              });
            }
          }
          const updated = await updateVersioned(tx, vendors, id, row.version, {
            status: to,
            updatedAt: now,
          });
          await this.audit.record(tx, {
            action: 'vendor.kyc_submitted',
            entityType: 'vendor',
            entityId: id,
            before: { status: row.status },
            after: { status: to },
          });
          return { status: 200, response: toVendorDto(updated, principal) };
        },
      );
      return done.response;
    });
  }

  /**
   * activate, suspend, block and archive (`vendor.activate`). Activation needs the creator to be someone else
   * (403 `separation_of_duties`) and an approved KYB case with no lapsed tax clearance (409 `kyb_not_verified`,
   * `kyc_expired`). The order of the answers is: not found, wrong status, own vendor, KYB.
   */
  async lifecycle(
    id: string,
    command: LifecycleCommand,
    reason: string | undefined,
    idempotencyKey: string,
  ): Promise<VendorDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: `vendor.${command}`, key: idempotencyKey, body: { id, reason: reason ?? null } },
        async () => {
          const row = await lockVendor(tx, scope.tenantId, id);
          if (row === undefined) throw vendorNotFound();
          this.assertVisible('vendor.activate', row, principal);
          if (!lifecycleAllowed(command, row.status)) {
            throw invalidTransition(command, row.status);
          }
          const to = LIFECYCLE[command].to;
          if (command === 'activate') {
            if (row.createdBy === principal.userId) {
              throw new ForbiddenException({
                code: 'forbidden',
                message: 'The creator of a vendor cannot activate it',
                reason: 'separation_of_duties',
              });
            }
            const kyb = await kybCaseOf(tx, scope.tenantId, id);
            if (kyb?.status !== 'approved') {
              throw new ConflictException({
                // Reuses the existing 409 code of the error filter: a domain code it does not list reads as `conflict`.
                code: 'kyb_not_verified',
                message: 'The vendor has no approved KYB case',
              });
            }
            if (lapsedTaxClearance(kyb.items, isoDay(now))) {
              throw new ConflictException({
                code: 'kyc_expired',
                message: 'The tax clearance of the vendor has expired; renew it in the KYB case',
              });
            }
          }
          const updated = await updateVersioned(tx, vendors, id, row.version, {
            status: to,
            ...(command === 'activate' && { approvedBy: principal.userId }),
            updatedAt: now,
          });
          await this.audit.record(tx, {
            action: `vendor.${to}`,
            entityType: 'vendor',
            entityId: id,
            before: { status: row.status },
            after: { status: to, ...(reason === undefined ? {} : { reason }) },
          });
          return { status: 200, response: toVendorDto(updated, principal) };
        },
      );
      return done.response;
    });
  }

  // ----------------------------------------------------------------------------------------------- contacts

  async listContacts(vendorId: string): Promise<VendorContactDto[]> {
    const { scope, principal } = this.caller.current();
    const vendor = await this.find(this.db, scope.tenantId, vendorId);
    if (vendor === undefined) throw vendorNotFound();
    this.assertVisible('vendor.read', vendor, principal);
    const rows = await this.db
      .select()
      .from(vendorContacts)
      .where(
        and(eq(vendorContacts.tenantId, scope.tenantId), eq(vendorContacts.vendorId, vendorId)),
      )
      .orderBy(
        sql`${vendorContacts.isPrimary} DESC`,
        asc(vendorContacts.fullName),
        asc(vendorContacts.id),
      );
    return rows.map(toContactDto);
  }

  /** The first contact of a vendor is its primary one (the body has no flag for it). */
  async createContact(
    vendorId: string,
    body: VendorContactBody,
    idempotencyKey: string,
  ): Promise<VendorContactDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'vendor.contact.create', key: idempotencyKey, body: { vendorId, ...body } },
        async () => {
          // The vendor row lock serialises two first contacts, so only one of them becomes primary.
          const vendor = await lockVendor(tx, scope.tenantId, vendorId);
          if (vendor === undefined) throw vendorNotFound();
          this.assertVisible('vendor.write', vendor, principal);
          const [existing] = await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(vendorContacts)
            .where(
              and(
                eq(vendorContacts.tenantId, scope.tenantId),
                eq(vendorContacts.vendorId, vendorId),
              ),
            );
          const [row] = await tx
            .insert(vendorContacts)
            .values({
              tenantId: scope.tenantId,
              vendorId,
              fullName: body.name,
              emailNorm: body.email === undefined ? null : normalizeEmail(body.email),
              phoneE164: body.phone ?? null,
              title: body.role ?? null,
              isPrimary: (existing?.n ?? 0) === 0,
              version: 1,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          return { status: 201, response: toContactDto(row!) };
        },
      );
      return done.response;
    });
  }

  async updateContact(
    vendorId: string,
    contactId: string,
    expectedVersion: number,
    fields: Omit<Partial<UpdateVendorContactBody>, 'expectedVersion'>,
  ): Promise<VendorContactDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    if (Object.values(fields).every((v) => v === undefined)) {
      throw new BadRequestException('at least one field to change is required');
    }
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const vendor = await lockVendor(tx, scope.tenantId, vendorId);
      if (vendor === undefined) throw vendorNotFound();
      this.assertVisible('vendor.write', vendor, principal);
      await this.requireContact(tx, scope.tenantId, vendorId, contactId);
      if (fields.isPrimary === true) {
        // At most one primary per vendor: the old one steps down first.
        await tx
          .update(vendorContacts)
          .set({ isPrimary: false, updatedAt: now, version: sql`${vendorContacts.version} + 1` })
          .where(
            and(
              eq(vendorContacts.tenantId, scope.tenantId),
              eq(vendorContacts.vendorId, vendorId),
              eq(vendorContacts.isPrimary, true),
              ne(vendorContacts.id, contactId),
            ),
          );
      }
      try {
        const updated = await updateVersioned(tx, vendorContacts, contactId, expectedVersion, {
          ...(fields.name !== undefined && { fullName: fields.name }),
          ...(fields.email !== undefined && {
            emailNorm: fields.email === null ? null : normalizeEmail(fields.email),
          }),
          ...(fields.phone !== undefined && { phoneE164: fields.phone }),
          ...(fields.role !== undefined && { title: fields.role }),
          ...(fields.isPrimary !== undefined && { isPrimary: fields.isPrimary }),
          updatedAt: now,
        });
        return toContactDto(updated);
      } catch (error) {
        if (isUnique(error, PRIMARY_CONTACT_INDEX)) {
          throw new ConflictException({
            code: 'primary_contact_exists',
            message: 'This vendor already has a primary contact',
          });
        }
        throw error;
      }
    });
  }

  async deleteContact(vendorId: string, contactId: string): Promise<void> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    await withTx(this.db, scope, actor, async (tx) => {
      const vendor = await lockVendor(tx, scope.tenantId, vendorId);
      if (vendor === undefined) throw vendorNotFound();
      this.assertVisible('vendor.write', vendor, principal);
      await this.requireContact(tx, scope.tenantId, vendorId, contactId);
      await tx
        .delete(vendorContacts)
        .where(and(eq(vendorContacts.tenantId, scope.tenantId), eq(vendorContacts.id, contactId)));
    });
  }

  // ----------------------------------------------------------------------------------------------- accounts

  /** The accounts of the vendor in the acting entity (an entity sees its own terms only). */
  async listAccounts(vendorId: string): Promise<VendorAccountDto[]> {
    const { scope, principal } = this.caller.current();
    const vendor = await this.find(this.db, scope.tenantId, vendorId);
    if (vendor === undefined) throw vendorNotFound();
    this.assertVisible('vendor.read', vendor, principal);
    const rows = await this.accountRows(this.db, scope.tenantId, vendorId, scope.organizationId);
    return rows.map((r) => toAccountDto(r.account, r.netDays));
  }

  /** 404 for the account of any entity other than the acting one, and for a vendor without that account. */
  async getAccount(vendorId: string, organizationId: string): Promise<VendorAccountDto> {
    const { scope, principal } = this.caller.current();
    const vendor = await this.find(this.db, scope.tenantId, vendorId);
    if (vendor === undefined) throw vendorNotFound();
    this.assertVisible('vendor.read', vendor, principal);
    const [found] = await this.accountRows(this.db, scope.tenantId, vendorId, organizationId);
    if (found === undefined) throw accountNotFound();
    // The account is entity-owned: can() compares its entity with the acting one, so another entity is out of scope.
    this.assertVisible('vendor.read', vendor, principal, found.account.organizationId);
    return toAccountDto(found.account, found.netDays);
  }

  /**
   * The vendor's terms with `organizationId` (default: the acting entity). The caller must be a member of that
   * entity (user_entities), else it is 404 like an unknown entity. One account per vendor and entity (409).
   */
  async createAccount(
    vendorId: string,
    body: CreateVendorAccountBody,
    idempotencyKey: string,
  ): Promise<VendorAccountDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    const organizationId = body.organizationId ?? scope.organizationId;
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        { command: 'vendor.account.create', key: idempotencyKey, body: { vendorId, ...body } },
        async () => {
          const vendor = await lockVendor(tx, scope.tenantId, vendorId);
          if (vendor === undefined) throw vendorNotFound();
          this.assertVisible('vendor.write', vendor, principal);
          if (vendor.status === 'blocked' || vendor.status === 'archived') {
            throw new ConflictException({
              code: 'vendor_not_editable',
              message: `A ${vendor.status} vendor cannot get a new account`,
            });
          }
          if (organizationId !== scope.organizationId) {
            const [member] = await tx
              .select({ id: userEntities.id })
              .from(userEntities)
              .where(
                and(
                  eq(userEntities.tenantId, scope.tenantId),
                  eq(userEntities.userId, principal.userId),
                  eq(userEntities.organizationId, organizationId),
                ),
              )
              .limit(1);
            if (member === undefined) {
              throw new NotFoundException({ code: 'not_found', message: 'Entity not found' });
            }
          }
          let netDays: number | null = null;
          if (body.paymentTermId !== undefined) {
            const [term] = await tx
              .select({ netDays: paymentTerms.netDays })
              .from(paymentTerms)
              .where(
                and(
                  eq(paymentTerms.tenantId, scope.tenantId),
                  eq(paymentTerms.id, body.paymentTermId),
                  eq(paymentTerms.isActive, true),
                ),
              );
            if (term === undefined) {
              throw new BadRequestException({
                code: 'bad_request',
                message: 'paymentTermId is not an active payment term of this tenant',
              });
            }
            netDays = term.netDays;
          }
          try {
            const [row] = await tx
              .insert(vendorAccounts)
              .values({
                tenantId: scope.tenantId,
                organizationId,
                vendorId,
                defaultCurrency: body.defaultCurrency ?? 'NPR',
                paymentTermId: body.paymentTermId ?? null,
                active: true,
                version: 1,
                createdAt: now,
                updatedAt: now,
              })
              .returning();
            return { status: 201, response: toAccountDto(row!, netDays) };
          } catch (error) {
            if (isUnique(error, ACCOUNT_UNIQUE)) {
              throw new ConflictException({
                code: 'account_exists',
                message: 'The vendor already has an account with this entity',
              });
            }
            throw error;
          }
        },
      );
      return done.response;
    });
  }

  // ------------------------------------------------------------------------------------------------ helpers

  /**
   * The vendors `p` may `action`, as SQL: the twin of can() for a record that names no entity. `all` is the whole
   * tenant for staff; `own` is the owner column. Anything else (no grant, a portal caller, an inactive user)
   * matches nothing.
   */
  private visibleWhere(tenantId: string, p: Principal, action: Permission): SQL {
    const none = sql`false`;
    if (p.status !== 'active' || p.orgKind !== 'staff') return none;
    const inTenant = eq(vendors.tenantId, tenantId);
    switch (p.grants.get(action)) {
      case 'all':
        return inTenant;
      case 'own':
        return and(inTenant, eq(vendors.ownerUserId, p.userId)) as SQL;
      default:
        return none;
    }
  }

  /**
   * TR-Q12d: a vendor added under a name another vendor of the tenant already has (vendorNameKey) is allowed, and
   * the audit trail names the namesakes, so a review can find a duplicate made on purpose. Tenant-wide, whatever
   * the caller may read; ids only.
   */
  private async recordSameName(
    tx: DbTransaction,
    tenantId: string,
    id: string,
    legalName: string,
  ): Promise<void> {
    const others = await tx
      .select({ id: vendors.id, legalName: vendors.legalName })
      .from(vendors)
      .where(and(eq(vendors.tenantId, tenantId), ne(vendors.id, id)))
      .orderBy(asc(vendors.id));
    const same = sameNameVendors(legalName, others);
    if (same.length === 0) return;
    await this.audit.record(tx, {
      action: 'vendor.created_with_same_name',
      entityType: 'vendor',
      entityId: id,
      after: { legalName },
      meta: { sameNameVendorIds: same.map((v) => v.id) },
    });
  }

  /** Record-level authz that answers 404, not 403, for a record outside the caller's scope. */
  private assertVisible(
    action: Permission,
    row: VendorRow,
    p: Principal,
    entityId: string = p.organizationId,
  ): void {
    try {
      this.authz.assert(action, { ...vendorRef(row, p), organizationId: entityId });
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw vendorNotFound();
      throw error;
    }
  }

  /** Vendors are written by staff only: a portal user holding a vendor permission by mistake is still refused. */
  private assertStaff(p: Principal): void {
    if (p.orgKind !== 'staff') {
      throw new ForbiddenException({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
    }
  }

  private async find(q: Q, tenantId: string, id: string): Promise<VendorRow | undefined> {
    const [row] = await q
      .select()
      .from(vendors)
      .where(and(eq(vendors.tenantId, tenantId), eq(vendors.id, id)));
    return row;
  }

  private async requireContact(
    tx: DbTransaction,
    tenantId: string,
    vendorId: string,
    contactId: string,
  ): Promise<void> {
    const [row] = await tx
      .select({ id: vendorContacts.id })
      .from(vendorContacts)
      .where(
        and(
          eq(vendorContacts.tenantId, tenantId),
          eq(vendorContacts.vendorId, vendorId),
          eq(vendorContacts.id, contactId),
        ),
      );
    if (row === undefined) {
      throw new NotFoundException({ code: 'not_found', message: 'Contact not found' });
    }
  }

  private async accountRows(
    q: Q,
    tenantId: string,
    vendorId: string,
    organizationId: string,
  ): Promise<{ account: AccountRow; netDays: number | null }[]> {
    return q
      .select({ account: vendorAccounts, netDays: paymentTerms.netDays })
      .from(vendorAccounts)
      .leftJoin(
        paymentTerms,
        and(
          eq(paymentTerms.tenantId, vendorAccounts.tenantId),
          eq(paymentTerms.id, vendorAccounts.paymentTermId),
        ),
      )
      .where(
        and(
          eq(vendorAccounts.tenantId, tenantId),
          eq(vendorAccounts.vendorId, vendorId),
          eq(vendorAccounts.organizationId, organizationId),
        ),
      );
  }

  /** 409 `duplicate_pan`, naming the vendor that holds the PAN. `exceptId` is the one being edited. */
  private async assertPanFree(
    tx: DbTransaction,
    tenantId: string,
    pan: string,
    exceptId?: string,
  ): Promise<void> {
    const [existing] = await tx
      .select({ id: vendors.id })
      .from(vendors)
      .where(
        and(
          eq(vendors.tenantId, tenantId),
          eq(vendors.pan, pan),
          exceptId === undefined ? undefined : ne(vendors.id, exceptId),
        ),
      )
      .limit(1);
    if (existing !== undefined) throw duplicatePan(pan, existing.id);
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
}

const accountNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Vendor account not found' });
