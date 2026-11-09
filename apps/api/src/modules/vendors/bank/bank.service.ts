// VendorBankService: a vendor's bank accounts under maker-checker (P4 unit V2, AD9). Serves the NFRs:
// - "a payment goes only to a verified account": an account is proposed (by staff, or by the vendor through the
//   portal) and becomes active only when another person verifies it with a clean call-back evidence document;
//   activeVerifiedAccount() is what a payment request (A2) reads, and it answers 409 `no_verified_bank_account`
//   while there is none;
// - "separation of duties": the verifier is never the proposer (403 `separation_of_duties` here, the
//   vendor_bank_accounts_maker_checker_check CHECK is the backstop);
// - "secrets at rest": the account number is normalised, sealed with FieldCipher under the AAD
//   `vendor_bank_accounts:<row id>` (the id is generated before the insert), fingerprinted with the keyed hash
//   and masked to its last four digits; no DTO, audit payload or idempotency hash carries the number;
// - "no double effects": every write takes an Idempotency-Key; verify locks the vendor row first, then the account,
//   and retires the previous active account before it activates the new one, in one transaction;
// - "authorization is deny-by-default": the vendor and its accounts are tenant-level (0032), so every query filters
//   the tenant by hand and the grant scope is decided by can() on vendorRef (as VendorsService does); an account
//   of another tenant or under another vendor is a 404.
import {
  type Permission,
  type ProposeBankAccountBody,
  type RejectBankAccountBody,
  type VendorBankAccountDto,
  type VerifyBankAccountBody,
} from '@bos/contracts';
import { vendorBankAccounts, vendors } from '@bos/db';
import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService } from '../../../platform/authz/authz.service';
import { type Principal } from '../../../platform/authz/can';
import { FieldCipher } from '../../../platform/crypto/field-cipher';
import { DB, type Db, type DbTransaction } from '../../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../../platform/db/idempotency';
import { withTx, type Actor, type TxScope } from '../../../platform/db/tx';
import { DocumentsService } from '../../../platform/documents/documents.service';
import { VendorsCaller } from '../vendors.caller';
import { lockVendor, type VendorRow } from '../vendors.queries';
import { vendorRef } from '../vendors.service';
import {
  BANK_EVIDENCE_OWNER_TYPE,
  bankAccountAad,
  evidenceIsClean,
  evidenceNotClean,
  noVerifiedBankAccount,
  normalizeAccountNumber,
  notProposed,
  proposerCannotVerify,
  toBankAccountDto,
  toSnapshot,
  type BankAccountRow,
  type VerifiedBankAccountSnapshot,
} from './bank.rules';

type Q = Db | DbTransaction;

const vendorNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Vendor not found' });
const accountNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Bank account not found' });
const forbidden = () =>
  new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: 'no_permission' });

interface ProposeInput {
  scope: TxScope;
  actor: Actor;
  proposedBy: string;
  via: 'staff' | 'portal';
  vendorId: string;
  body: ProposeBankAccountBody;
  idempotencyKey: string | undefined;
}

@Injectable()
export class VendorBankService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly authz: AuthzService,
    private readonly caller: VendorsCaller,
    private readonly cipher: FieldCipher,
    private readonly documents: DocumentsService,
    private readonly audit: AuditService,
  ) {}

  // --------------------------------------------------------------------------------------------------- read

  /** The vendor's accounts, newest first, as DTOs with the last four digits only. */
  async list(vendorId: string): Promise<VendorBankAccountDto[]> {
    const { scope, principal } = this.caller.current();
    this.assertStaff(principal);
    await this.visibleVendor(this.db, scope.tenantId, vendorId, 'vendor.read', principal);
    const rows = await this.db
      .select()
      .from(vendorBankAccounts)
      .where(
        and(
          eq(vendorBankAccounts.tenantId, scope.tenantId),
          eq(vendorBankAccounts.vendorId, vendorId),
        ),
      )
      .orderBy(desc(vendorBankAccounts.createdAt), desc(vendorBankAccounts.id));
    return rows.map(toBankAccountDto);
  }

  async get(vendorId: string, accountId: string): Promise<VendorBankAccountDto> {
    const { scope, principal } = this.caller.current();
    this.assertStaff(principal);
    await this.visibleVendor(this.db, scope.tenantId, vendorId, 'vendor.read', principal);
    const row = await this.findAccount(this.db, scope.tenantId, vendorId, accountId);
    if (row === undefined) throw accountNotFound();
    return toBankAccountDto(row);
  }

  /**
   * The vendor's active, verified account as a snapshot for a payment request (A2). No authz: the caller
   * authorized its own command. Pass `tx` to read inside that command's transaction (after its vendor lock).
   * 409 `no_verified_bank_account` when the vendor has none (only proposed, rejected or retired accounts).
   */
  async activeVerifiedAccount(
    scope: TxScope,
    vendorId: string,
    tx?: DbTransaction,
  ): Promise<VerifiedBankAccountSnapshot> {
    const [row] = await (tx ?? this.db)
      .select()
      .from(vendorBankAccounts)
      .where(
        and(
          eq(vendorBankAccounts.tenantId, scope.tenantId),
          eq(vendorBankAccounts.vendorId, vendorId),
          eq(vendorBankAccounts.status, 'active'),
        ),
      );
    if (row === undefined) throw noVerifiedBankAccount();
    return toSnapshot(row);
  }

  // ------------------------------------------------------------------------------------------------ propose

  /** Staff proposal (`vendor.bank.propose`). 201 with the proposed account. */
  async propose(
    vendorId: string,
    body: ProposeBankAccountBody,
    idempotencyKey: string,
  ): Promise<VendorBankAccountDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    await this.visibleVendor(this.db, scope.tenantId, vendorId, 'vendor.bank.propose', principal);
    return this.insertProposal({
      scope,
      actor,
      proposedBy: principal.userId,
      via: 'staff',
      vendorId,
      body,
      idempotencyKey,
    });
  }

  /**
   * A proposal from the vendor portal (PV2 calls this). The caller must be a portal user of the vendor party
   * itself holding `portal.vendor.submit`; another party's vendor is a 404, a staff caller a 403. PV2 owns the
   * portal route and its Idempotency-Key; without a key the proposal is not deduplicated here.
   */
  async proposeFromPortal(
    scope: TxScope,
    vendorPartyId: string,
    body: ProposeBankAccountBody,
    idempotencyKey?: string,
  ): Promise<VendorBankAccountDto> {
    const { actor, principal } = this.caller.current();
    if (principal.orgKind !== 'vendor' || principal.tenantId !== scope.tenantId) throw forbidden();
    await this.visibleVendor(
      this.db,
      scope.tenantId,
      vendorPartyId,
      'portal.vendor.submit',
      principal,
    );
    return this.insertProposal({
      scope,
      actor,
      proposedBy: principal.userId,
      via: 'portal',
      vendorId: vendorPartyId,
      body,
      idempotencyKey,
    });
  }

  // ------------------------------------------------------------------------------------------------- decide

  /**
   * `vendor.bank.verify`. The order of the answers: vendor or account not found (404), not proposed (409), the
   * verifier proposed it (403), evidence not a clean document of this account (409). Then the previous active
   * account is retired and this one activated, in that order (the one-active index is checked per statement).
   */
  async verify(
    vendorId: string,
    accountId: string,
    body: VerifyBankAccountBody,
    idempotencyKey: string,
  ): Promise<VendorBankAccountDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    await this.visibleVendor(this.db, scope.tenantId, vendorId, 'vendor.bank.verify', principal);
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        {
          command: 'vendor.bank.verify',
          key: idempotencyKey,
          body: { vendorId, accountId, ...body },
        },
        async () => {
          if ((await lockVendor(tx, scope.tenantId, vendorId)) === undefined) {
            throw vendorNotFound();
          }
          const row = await this.findAccount(tx, scope.tenantId, vendorId, accountId, true);
          if (row === undefined) throw accountNotFound();
          if (row.status !== 'proposed') throw notProposed(row.status);
          if (row.proposedBy === principal.userId) throw proposerCannotVerify();
          const versions = await this.documents.listForOwner(
            scope,
            BANK_EVIDENCE_OWNER_TYPE,
            accountId,
          );
          if (!evidenceIsClean(versions, body.callbackEvidenceDocumentId)) {
            throw evidenceNotClean();
          }

          const now = new Date();
          const retired = await tx
            .update(vendorBankAccounts)
            .set({
              status: 'retired',
              updatedAt: now,
              version: sql`${vendorBankAccounts.version} + 1`,
            })
            .where(
              and(
                eq(vendorBankAccounts.tenantId, scope.tenantId),
                eq(vendorBankAccounts.vendorId, vendorId),
                eq(vendorBankAccounts.status, 'active'),
              ),
            )
            .returning({ id: vendorBankAccounts.id });
          const updated = await updateVersioned(tx, vendorBankAccounts, accountId, row.version, {
            status: 'active',
            verifiedBy: principal.userId,
            callbackEvidenceDocumentId: body.callbackEvidenceDocumentId,
            updatedAt: now,
          });
          await this.audit.record(tx, {
            action: 'vendor.bank_account_verified',
            entityType: 'vendor_bank_account',
            entityId: accountId,
            before: { status: row.status, last4: row.last4 },
            after: {
              status: updated.status,
              last4: updated.last4,
              callbackEvidenceDocumentId: body.callbackEvidenceDocumentId,
              retiredAccountIds: retired.map((r) => r.id),
            },
          });
          return { status: 200, response: toBankAccountDto(updated) };
        },
      );
      return done.response;
    });
  }

  /** `vendor.bank.verify`: a proposed account is rejected; the reason goes into the audit event. */
  async reject(
    vendorId: string,
    accountId: string,
    body: RejectBankAccountBody,
    idempotencyKey: string,
  ): Promise<VendorBankAccountDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertStaff(principal);
    await this.visibleVendor(this.db, scope.tenantId, vendorId, 'vendor.bank.verify', principal);
    return withTx(this.db, scope, actor, async (tx) => {
      const done = await withIdempotency(
        tx,
        {
          command: 'vendor.bank.reject',
          key: idempotencyKey,
          body: { vendorId, accountId, ...body },
        },
        async () => {
          if ((await lockVendor(tx, scope.tenantId, vendorId)) === undefined) {
            throw vendorNotFound();
          }
          const row = await this.findAccount(tx, scope.tenantId, vendorId, accountId, true);
          if (row === undefined) throw accountNotFound();
          if (row.status !== 'proposed') throw notProposed(row.status);
          const updated = await updateVersioned(tx, vendorBankAccounts, accountId, row.version, {
            status: 'rejected',
            updatedAt: new Date(),
          });
          await this.audit.record(tx, {
            action: 'vendor.bank_account_rejected',
            entityType: 'vendor_bank_account',
            entityId: accountId,
            before: { status: row.status, last4: row.last4 },
            after: { status: updated.status, last4: updated.last4, reason: body.reason },
          });
          return { status: 200, response: toBankAccountDto(updated) };
        },
      );
      return done.response;
    });
  }

  // ------------------------------------------------------------------------------------------------ helpers

  /**
   * Normalise, then seal, fingerprint and mask the same value. The idempotency hash gets the fingerprint, never
   * the number: an unsalted hash of a short number and known fields could be brute-forced.
   */
  private async insertProposal(input: ProposeInput): Promise<VendorBankAccountDto> {
    const { scope, actor, vendorId, body } = input;
    const { number, last4 } = normalizeAccountNumber(body.accountNumber);
    const fingerprint = this.cipher.fingerprint(number);
    const run = async (tx: DbTransaction) => {
      if ((await lockVendor(tx, scope.tenantId, vendorId)) === undefined) throw vendorNotFound();
      const id = randomUUID();
      const [row] = await tx
        .insert(vendorBankAccounts)
        .values({
          id,
          tenantId: scope.tenantId,
          vendorId,
          bankName: body.bankName,
          accountName: body.accountName,
          accountNumberEnc: this.cipher.encrypt(number, bankAccountAad(id)),
          accountFingerprint: fingerprint,
          last4,
          proposedBy: input.proposedBy,
          proposedVia: input.via,
        })
        .returning();
      return { status: 201, response: toBankAccountDto(row as BankAccountRow) };
    };
    return withTx(this.db, scope, actor, async (tx) => {
      if (input.idempotencyKey === undefined) return (await run(tx)).response;
      const done = await withIdempotency(
        tx,
        {
          command: `vendor.bank.propose.${input.via}`,
          key: input.idempotencyKey,
          body: {
            vendorId,
            bankName: body.bankName,
            accountName: body.accountName,
            fingerprint,
          },
        },
        () => run(tx),
      );
      return done.response;
    });
  }

  /** The vendor, after can() on its ref; out of the caller's scope reads as 404, like VendorsService. */
  private async visibleVendor(
    q: Q,
    tenantId: string,
    vendorId: string,
    action: Permission,
    p: Principal,
  ): Promise<VendorRow> {
    const [row] = await q
      .select()
      .from(vendors)
      .where(and(eq(vendors.tenantId, tenantId), eq(vendors.id, vendorId)));
    if (row === undefined) throw vendorNotFound();
    try {
      this.authz.assert(action, vendorRef(row, p));
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw vendorNotFound();
      throw error;
    }
    return row;
  }

  private async findAccount(
    q: Q,
    tenantId: string,
    vendorId: string,
    accountId: string,
    forUpdate = false,
  ): Promise<BankAccountRow | undefined> {
    const query = q
      .select()
      .from(vendorBankAccounts)
      .where(
        and(
          eq(vendorBankAccounts.tenantId, tenantId),
          eq(vendorBankAccounts.vendorId, vendorId),
          eq(vendorBankAccounts.id, accountId),
        ),
      );
    const [row] = forUpdate ? await query.for('update') : await query;
    return row;
  }

  /** Staff routes refuse a portal user who holds a vendor permission by mistake. */
  private assertStaff(p: Principal): void {
    if (p.orgKind !== 'staff') throw forbidden();
  }
}
