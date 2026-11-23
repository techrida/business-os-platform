// VerificationService: the KYB (know your business) case of a customer or a vendor. Serves the NFRs:
// - "no approval without evidence": an approval needs every required checklist item backed by a document
//   that each file on the submitted checklist passed its virus scan;
// - "separation of duties": whoever submitted the case cannot decide it;
// - "no double decisions" and "no lost updates": every state change locks the case row and goes through
//   updateVersioned with the version the caller saw; a decision also honours the Idempotency-Key;
// - "every change is audited": each write runs in withTx (the audit trigger records the row change) and adds a
//   domain event through AuditService.
// Cases are tenant-level (ADR 0027): one per party, visible from every legal entity of the tenant, so the
// lookups filter on the tenant alone. Another tenant's case is not found, never forbidden.
// The party is reached through a PartyOwnerPort chosen by the case's party kind (party-owner.port.ts), and the
// checklist is chosen by the kind too (verification.rules.ts).
// The submit writes submitted_by_user_id and submitted_at; only a decision writes reviewer_user_id and decided_at.
// The write routes carry no single route-level permission (customer.write or vendor.write, by kind), so every write
// starts with assertKybWriter: a caller holding no kind's write permission is refused before anything is read.
import {
  ChecklistItemSchema,
  VERIFICATION_PARTY_KINDS,
  VerificationEvidenceSchema,
  VerificationReviewHistorySchema,
  type ReviewVerificationItemBody,
  type VerificationReviewHistory,
  type AttachVerificationDocumentBody,
  type AccessLevel,
  type ChecklistItem,
  type Permission,
  type RoleKey,
  ROLE_KEYS,
  type RemoveVerificationDocumentBody,
  type VerificationCaseCan,
  type VerificationCaseDto,
  type VerificationPartyKind,
} from '@bos/contracts';
import { parties, users, verificationCases, verificationReviewEvents } from '@bos/db';
import { kathmanduDateString } from '@bos/locale';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
  type OnModuleInit,
} from '@nestjs/common';
import { sql, getTableColumns, and, asc, desc, eq, inArray, lt, or, type SQL } from 'drizzle-orm';

import { AuditService } from '../../platform/audit/audit.service';
import { AuthzService } from '../../platform/authz/authz.service';
import { can as decide, type Principal, type ResourceRef } from '../../platform/authz/can';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { updateVersioned, withIdempotency } from '../../platform/db/idempotency';
import { withTx, type TxScope } from '../../platform/db/tx';
import {
  type DocumentOwnerPolicy,
  type UploadGrant,
} from '../../platform/documents/documents.ports';
import { assertNotInfected, DocumentsService } from '../../platform/documents/documents.service';
import { searchPage } from '../../platform/list';
import { CustomerPartyOwner } from './customer-party-owner';
import {
  PartyOwnerRegistry,
  type PartyLabel,
  type PartyOwnerPort,
  type PartyQuery,
} from './party-owner.port';
import { VerificationCaller } from './verification.caller';
import {
  acceptProvided,
  attachDocument,
  checklistKeysFor,
  defaultChecklistFor,
  documentProblems,
  documentsBeforeReset,
  FILE_BEFORE_CHANGE_MESSAGE,
  isEditable,
  missingRequired,
  reopenChecklist,
  requiresExpiry,
} from './verification.rules';
import {
  VERIFICATION_OWNER_TYPE,
  type CreateVerificationCaseBody,
  type DecisionBody,
  type ListVerificationCasesQuery,
} from './verification.types';

type CaseRow = typeof verificationCases.$inferSelect;
type Q = PartyQuery;

/** A case with the owner of its party (what the `own` scope of verification.read means) and the party's port. */
export interface Loaded {
  row: CaseRow;
  partyOwnerUserId: string | null;
  port: PartyOwnerPort;
}

/** How many cases one scan step reads before the per-case read check. */
const SCAN_BATCH = 500;

const CUSTOMER_LABEL = 'Customer';

const notFound = (what: string) =>
  new NotFoundException({ code: 'not_found', message: `${what} not found` });
const conflict = (message: string) => new ConflictException({ code: 'conflict', message });
const separationOfDuties = () =>
  new ForbiddenException({
    code: 'forbidden',
    message: 'Forbidden',
    reason: 'separation_of_duties',
  });

const checklistOf = (row: CaseRow): ChecklistItem[] =>
  ChecklistItemSchema.array().parse(row.checklist);

export function toVerificationCaseDto(row: CaseRow): VerificationCaseDto {
  return {
    partyKind: row.partyKind,
    reviewPolicy: row.reviewPolicy,
    reviewRound: row.reviewRound,
    submittedBy: row.submittedByUserId,
    id: row.id,
    partyId: row.partyId,
    status: row.status,
    checklist: checklistOf(row),
    reviewedBy: row.reviewerUserId,
    decidedAt: row.decidedAt === null ? null : row.decidedAt.toISOString(),
    decisionNote: row.reason,
    version: row.version,
  };
}

/** A case's party name and number from `labels`; both null when the party was not found. */
function labelOf(
  labels: ReadonlyMap<string, PartyLabel>,
  row: Pick<CaseRow, 'partyKind' | 'partyId'>,
): { partyName: string | null; partyNumber: string | null } {
  const label = labels.get(`${row.partyKind}:${row.partyId}`);
  return { partyName: label?.name ?? null, partyNumber: label?.number ?? null };
}

/**
 * What `p` may do with this case, by the same record checks the write and review routes make: review needs
 * verification.review and, like every review route, someone other than the case's submitter (separation of
 * duties); edit needs the kind's write permission (and verification read, as every write here does);
 * attach adds documents.upload on the case ref for customer cases, or route-level documents.upload for vendor
 * cases (U18 Q9 b: vendor.write + verification.read on the case ref authorises uploads); remove matches edit.
 */
export function caseCapabilities(p: Principal, scope: TxScope, l: Loaded): VerificationCaseCan {
  const ref = caseRef(scope, l);
  const allowed = (action: Permission) => decide(p, action, ref).allowed;
  const staff = p.orgKind === 'staff';
  const edit = staff && allowed(l.port.writePermission) && allowed('verification.read');
  const canUpload =
    l.row.partyKind === 'vendor'
      ? decide(p, 'documents.upload').allowed
      : allowed('documents.upload');
  return {
    review: staff && allowed('verification.review') && l.row.submittedByUserId !== p.userId,
    edit,
    attach: edit && canUpload,
    remove: edit,
  };
}

/** What authz decides on: the acting entity stands in for the organization of a tenant-level record. */
function caseRef(scope: TxScope, l: Loaded): ResourceRef {
  return {
    tenantId: l.row.tenantId,
    organizationId: scope.organizationId,
    ownerUserId: l.partyOwnerUserId,
    ...l.port.counterparty(l.row.partyId),
    sodUserIds: [],
  };
}

/** 403 stays 403 (no grant, inactive user); a record outside the caller's scope becomes 404. */
function hideOutOfScope(error: unknown, what: string): never {
  const reason =
    error instanceof ForbiddenException
      ? (error.getResponse() as { reason?: unknown }).reason
      : undefined;
  if (reason === 'out_of_scope') throw notFound(what);
  throw error;
}

@Injectable()
export class VerificationService implements OnModuleInit {
  /** The customer adapter is built in; the vendor adapter is registered by P4 V1 (`registerPartyOwner`). */
  private readonly partyOwners = new PartyOwnerRegistry([new CustomerPartyOwner()]);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly documents: DocumentsService,
    private readonly authz: AuthzService,
    private readonly audit: AuditService,
    private readonly caller: VerificationCaller,
  ) {}

  /** Overridable in tests. */
  protected now(): Date {
    return new Date();
  }

  /**
   * The registration point of a party kind (P4 V1 registers the vendor adapter here). Until a kind is registered,
   * its parties are "not found" for the verification routes. Call it once per kind, before requests are served.
   */
  registerPartyOwner(port: PartyOwnerPort): void {
    this.partyOwners.register(port);
  }

  /** Registers how the documents of a case are authorized. Runs once, when the module starts. */
  onModuleInit(): void {
    const policy: DocumentOwnerPolicy = {
      ownerType: VERIFICATION_OWNER_TYPE,
      // The reviewer must see the files they decide on. verification.review on the case authorises reading its
      // files beside documents.read (audit #19: pmo reviews every case but holds documents.read only for its own
      // records). It opens this owner type's files only; it never widens documents.read elsewhere.
      readPermission: 'verification.review',
      resource: async (scope, ownerId) => {
        const l = await this.load(this.db, scope.tenantId, ownerId);
        return l === undefined ? null : caseRef(scope, l);
      },
      // U18 Q9 b: procurement attaches files to any vendor KYB case it can see, not only vendors it owns.
      // Customer cases stay on `documents.upload` alone; vendor cases also accept `vendor.write` on the case ref
      // when the caller holds `verification.read` on that same ref (preserving tenant and entity scoping).
      uploadGrants: async (scope, ownerId) => {
        const l = await this.load(this.db, scope.tenantId, ownerId);
        if (l === undefined) return null;
        const ref = caseRef(scope, l);
        const grants: UploadGrant[] = [{ action: 'documents.upload', ref }];
        if (l.row.partyKind === 'vendor' && this.mayRead(scope, l)) {
          grants.push({ action: l.port.writePermission, ref });
        }
        return grants;
      },
      // A submitted or decided case is frozen: the reviewer decides on exactly the files that were there.
      // FOR SHARE on the case row when a transaction is given, so an upload and a submit cannot interleave.
      canAttach: async (scope, ownerId, tx) => {
        const l = await this.load(tx ?? this.db, scope.tenantId, ownerId, tx ? 'share' : undefined);
        return l !== undefined && isEditable(l.row.status);
      },
      // P4 PV2: a vendor portal caller uploads KYC files to its own vendor case only. The case row is read in the
      // upload transaction; canAttach (draft or rejected) and the type, size and scan rules still apply after it.
      allowsCounterparty: async (who, ownerId, tx) => {
        if (who.kind !== 'vendor') return false;
        const [row] = await tx
          .select({ id: verificationCases.id })
          .from(verificationCases)
          .where(
            and(
              eq(verificationCases.tenantId, who.tenantId),
              eq(verificationCases.id, ownerId),
              eq(verificationCases.partyId, who.partyId),
              eq(verificationCases.partyKind, 'vendor'),
            ),
          );
        return row !== undefined;
      },
    };
    this.documents.registerOwner(policy);
  }

  // -------------------------------------------------------------------------------------------------- read

  /**
   * One page of the cases the caller may read, and how many there are in all. The caller's scope is applied in
   * SQL via `readableWhere` before pagination (audit #9), and `mayRead` stays as the per-row record check so a
   * list never shows what GET /:id would refuse. Each page row carries its party's name and number (audit #8).
   */
  async list(
    query: ListVerificationCasesQuery,
  ): Promise<{ rows: VerificationCaseDto[]; total: number }> {
    const { scope, principal } = this.caller.current();
    const readable = async (
      tx: Db | DbTransaction,
      where: SQL | undefined,
      order: SQL[],
      need: number,
    ): Promise<Loaded[]> => {
      const out: Loaded[] = [];
      for (let offset = 0; out.length < need; offset += SCAN_BATCH) {
        const cases = await tx
          .select(getTableColumns(verificationCases))
          .from(verificationCases)
          .innerJoin(
            parties,
            and(
              eq(parties.tenantId, verificationCases.tenantId),
              eq(parties.id, verificationCases.partyId),
            ),
          )
          .where(where)
          .orderBy(...order)
          .limit(SCAN_BATCH)
          .offset(offset);
        const owned = await this.withOwners(tx, scope.tenantId, cases);
        out.push(...owned.filter((l) => this.mayRead(scope, l)));
        if (cases.length < SCAN_BATCH) break;
      }
      return out;
    };
    const { rows, total } = await searchPage(this.db, {
      q: query.q,
      columns: [parties.name, parties.code],
      where: and(
        eq(verificationCases.tenantId, scope.tenantId),
        query.status === undefined ? undefined : inArray(verificationCases.status, query.status),
        query.partyKind === undefined
          ? undefined
          : inArray(verificationCases.partyKind, query.partyKind),
        query.partyId === undefined ? undefined : eq(verificationCases.partyId, query.partyId),
        // The caller's scope in SQL, before the limit: an own-scope reader gets their newest cases, not the
        // tenant's newest 500 filtered down (audit #9). mayRead above stays as the record-level check.
        this.readableWhere(scope.tenantId, principal),
      ),
      orderBy: [desc(verificationCases.createdAt), desc(verificationCases.id)],
      limit: query.limit,
      offset: query.offset,
      rows: async (tx, p) =>
        (await readable(tx, p.where, p.orderBy, p.offset + p.limit)).slice(
          p.offset,
          p.offset + p.limit,
        ),
      // An id-ordered scan with no stop: the count must see every readable match.
      count: async (tx, where) =>
        (await readable(tx, where, [asc(verificationCases.id)], Infinity)).length,
    });
    // Each party's name and number, one query per kind, under the case's own read (audit #8).
    const labels = await this.labelsOf(scope.tenantId, rows);
    return {
      rows: rows.map((l) => ({ ...toVerificationCaseDto(l.row), ...labelOf(labels, l.row) })),
      total,
    };
  }

  /** The labels of the cases' parties, one query per party kind, keyed by `${kind}:${partyId}`. */
  private async labelsOf(
    tenantId: string,
    cases: readonly Loaded[],
  ): Promise<ReadonlyMap<string, PartyLabel>> {
    const out = new Map<string, PartyLabel>();
    for (const kind of new Set(cases.map((l) => l.row.partyKind))) {
      const ofKind = cases.filter((l) => l.row.partyKind === kind);
      const port = ofKind[0]?.port;
      if (port === undefined) continue;
      const found = await port.labelsOf(
        this.db,
        tenantId,
        ofKind.map((l) => l.row.partyId),
      );
      for (const [id, label] of found) out.set(`${kind}:${id}`, label);
    }
    return out;
  }

  async get(id: string): Promise<VerificationCaseDto> {
    const { scope } = this.caller.current();
    const l = await this.load(this.db, scope.tenantId, id);
    if (l === undefined) throw notFound('Verification case');
    this.assertVisible('verification.read', scope, l);
    const label = labelOf(await this.labelsOf(scope.tenantId, [l]), l.row);
    const can = caseCapabilities(this.caller.current().principal, scope, l);
    // Both party kinds: the decision routes refuse the submitter (separation of duties) whatever the kind.
    const reviewBlockedReason =
      l.row.submittedByUserId === this.caller.current().principal.userId
        ? 'The submitter cannot review this case.'
        : null;
    const versions = await this.documents.listForOwner(scope, VERIFICATION_OWNER_TYPE, id);
    const used = new Set(checklistOf(l.row).map((i) => i.documentId));
    const latest = new Map<string, (typeof versions)[number]>();
    for (const v of versions)
      if (
        !used.has(v.documentId) &&
        (!latest.has(v.documentId) || latest.get(v.documentId)!.version < v.version)
      )
        latest.set(v.documentId, v);
    const reset = {
      identityReset: await this.identityResetOf(scope.tenantId, l.row),
      beforeChangeDocumentIds: [...documentsBeforeReset(versions, l.row.identityResetAt)],
    };
    if (l.row.partyKind === 'vendor') {
      return {
        ...toVerificationCaseDto(l.row),
        ...label,
        can,
        reviewBlockedReason,
        looseEvidence: [...latest.values()],
        ...reset,
      };
    }
    const items = checklistOf(l.row);
    const eligible = versions.filter((v) => v.status !== 'rejected');
    const evidenceReady = items
      .filter((i) => i.documentId)
      .every((i) => {
        const v = versions
          .filter((v) => v.documentId === i.documentId)
          .sort((a, b) => b.version - a.version)[0];
        return (
          v?.id === i.evidence?.documentVersionId &&
          v?.status === 'clean' &&
          v.sha256 &&
          v.scannedAt &&
          (!i.expiresOn || i.expiresOn > kathmanduDateString(this.now()))
        );
      });
    const clean = eligible.every(
      (v) =>
        eligible.some((newer) => newer.documentId === v.documentId && newer.version > v.version) ||
        v.status === 'clean',
    );
    const approvalBlockedReason =
      l.row.reviewPolicy !== 'document_review_v1'
        ? 'Customer case requires document review activation'
        : l.row.status !== 'submitted'
          ? 'Only a submitted case can be approved'
          : !items.some((i) => i.required) ||
              items.some((i) => i.required && !i.documentId) ||
              items.some(
                (i) =>
                  i.documentId &&
                  (i.status !== 'accepted' || i.review?.round !== l.row.reviewRound),
              )
            ? 'Every supplied document needs explicit approval'
            : !evidenceReady || !clean
              ? 'All active evidence must be readable, clean, unchanged and unexpired'
              : null;
    return {
      ...toVerificationCaseDto(l.row),
      ...label,
      can,
      approvalBlockedReason,
      reviewerNames:
        l.row.status === 'submitted'
          ? await this.reviewerNames(scope, l.row.submittedByUserId)
          : [],
      looseEvidence: [...latest.values()],
      reviewBlockedReason,
      ...reset,
    };
  }

  /** Who reset the case by changing the party's identity, and when; null for a case that never was reset. */
  private async identityResetOf(
    tenantId: string,
    row: Pick<CaseRow, 'identityResetAt' | 'identityResetByUserId' | 'status'>,
  ): Promise<{ at: string; by: string; byName: string | null } | null> {
    if (row.identityResetAt === null || row.identityResetByUserId === null) return null;
    // The note says "upload the documents again": it goes once the case is submitted again or decided.
    if (row.status !== 'draft' && row.status !== 'rejected') return null;
    const [user] = await this.db
      .select({ name: users.displayName })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, row.identityResetByUserId)));
    return {
      at: row.identityResetAt.toISOString(),
      by: row.identityResetByUserId,
      byName: user?.name ?? null,
    };
  }

  /**
   * Name active staff who can open the files and review any case in this entity: verification.review and
   * verification.read at scope all. The review grant also opens the case files (the owner policy's
   * readPermission), so documents.read is not required (audit #19: pmo was missing from this list).
   * The grant is read through the role cache, as a request is, so a tenant still on the built-in defaults (no
   * `role_permissions` rows) and a level-based grant count (R5 FU6; FU3 fixed the same picker for customers).
   */
  private async reviewerNames(scope: TxScope, submittedBy: string | null): Promise<string[]> {
    const result = await this.db.execute<{
      id: string;
      name: string;
      level: AccessLevel;
      role: string;
    }>(sql`
      SELECT u.id, u.display_name AS name,
             CASE WHEN e.department_id IS NULL THEN 'staff' ELSE e.level END AS level, r.role_key AS role
      FROM app.users u
      JOIN app.idp_orgs o ON o.tenant_id = u.tenant_id AND o.id = u.idp_org_id AND o.kind = 'staff'
      JOIN app.user_entities e ON e.tenant_id = u.tenant_id AND e.user_id = u.id
      JOIN app.user_roles r ON r.tenant_id = u.tenant_id AND r.user_id = u.id
        AND (e.role_keys IS NULL OR r.role_key = ANY(e.role_keys))
      WHERE u.tenant_id = ${scope.tenantId} AND e.organization_id = ${scope.organizationId}
        AND u.status = 'active' AND NULLIF(btrim(u.display_name), '') IS NOT NULL
        AND u.id IS DISTINCT FROM ${submittedBy}::uuid
    `);
    const people = new Map<string, { name: string; level: AccessLevel; roles: RoleKey[] }>();
    for (const row of result.rows) {
      if (!(ROLE_KEYS as readonly string[]).includes(row.role)) continue;
      const person = people.get(row.id) ?? { name: row.name, level: row.level, roles: [] };
      person.roles.push(row.role as RoleKey);
      people.set(row.id, person);
    }
    const names = new Set<string>();
    for (const person of people.values()) {
      const options = { scope: 'all', level: person.level } as const;
      if (
        (await this.authz.rolesHold(
          scope.tenantId,
          scope.organizationId,
          person.roles,
          'verification.review',
          options,
        )) &&
        (await this.authz.rolesHold(
          scope.tenantId,
          scope.organizationId,
          person.roles,
          'verification.read',
          options,
        ))
      ) {
        names.add(person.name);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }

  // ------------------------------------------------------------------------------------------------ create

  /**
   * One case per party. A new case is created (created: true). An existing case is returned as it is,
   * except an expired one, which is reopened in place: back to draft, items whose document lapsed emptied.
   */
  async create(
    body: CreateVerificationCaseBody,
  ): Promise<{ case: VerificationCaseDto; created: boolean }> {
    const { scope, actor } = this.caller.current();
    this.assertKybWriter();
    const now = this.now();
    return withTx(this.db, scope, actor, async (tx) => {
      // The party's kind picks the adapter. A party of another tenant, a kind without an adapter (a vendor, until
      // V1 registers one) and a merged-away customer are all "not a customer here".
      const [party] = await tx
        .select({ kind: parties.kind })
        .from(parties)
        .where(and(eq(parties.tenantId, scope.tenantId), eq(parties.id, body.partyId)));
      const port = party === undefined ? undefined : this.partyOwners.find(party.kind);
      const found =
        port === undefined ? undefined : await port.findLive(tx, scope.tenantId, body.partyId);
      if (port === undefined || found === undefined) {
        throw notFound(port?.label ?? CUSTOMER_LABEL);
      }
      const kind = port.kind;
      try {
        this.authz.assert(port.writePermission, {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          ownerUserId: found.ownerUserId,
          ...port.counterparty(found.id),
          sodUserIds: [],
        });
        this.authz.assert('verification.read', {
          tenantId: scope.tenantId,
          organizationId: scope.organizationId,
          ownerUserId: found.ownerUserId,
          ...port.counterparty(found.id),
          sodUserIds: [],
        });
      } catch (error) {
        hideOutOfScope(error, port.label);
      }

      const inserted = await tx
        .insert(verificationCases)
        .values({
          tenantId: scope.tenantId,
          partyId: body.partyId,
          partyKind: kind,
          status: 'draft',
          reviewPolicy: kind === 'customer' ? 'document_review_v1' : 'case_review_v0',
          checklist: [...defaultChecklistFor(kind)],
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: [verificationCases.tenantId, verificationCases.partyId] })
        .returning({ id: verificationCases.id });
      const created = inserted[0];
      if (created !== undefined) {
        const l = await this.lock(tx, scope.tenantId, created.id);
        await this.audit.record(tx, {
          action: 'verification.created',
          entityType: 'verification_case',
          entityId: l.row.id,
          after: { partyId: l.row.partyId, status: l.row.status },
        });
        return { case: toVerificationCaseDto(l.row), created: true };
      }

      // The case exists (this transaction waited for a concurrent insert, if there was one).
      const [existing] = await tx
        .select({ id: verificationCases.id })
        .from(verificationCases)
        .where(
          and(
            eq(verificationCases.tenantId, scope.tenantId),
            eq(verificationCases.partyId, body.partyId),
          ),
        );
      const l = await this.lock(tx, scope.tenantId, existing!.id);
      if (l.row.status !== 'expired') return { case: toVerificationCaseDto(l.row), created: false };

      await this.preserveLegacyDecision(tx, l.row);
      const reopened = await updateVersioned(tx, verificationCases, l.row.id, l.row.version, {
        status: 'draft',
        reviewPolicy: l.row.partyKind === 'customer' ? 'document_review_v1' : 'case_review_v0',
        checklist: reopenChecklist(checklistOf(l.row), kathmanduDateString(now)),
        reviewerUserId: null,
        decidedAt: null,
        reason: null,
        updatedAt: now,
      });
      await this.audit.record(tx, {
        action: 'verification.reopened',
        entityType: 'verification_case',
        entityId: reopened.id,
        before: { status: 'expired', version: l.row.version },
        after: { status: 'draft', version: reopened.version },
      });
      return { case: toVerificationCaseDto(reopened), created: false };
    });
  }

  /**
   * Resets a party's verification case after a change of its identity (legal name, PAN, kind or country) before
   * approval, inside the caller's transaction, so the party and its case change together. Authorization is the
   * caller's (it holds the party's write permission). The case goes back to draft with every checklist row emptied:
   * every required document is uploaded and reviewed again. For a customer's document-review case the review round
   * moves on too, which closes the old round: no earlier approval counts for the new one. The files stay on the
   * case as history, marked "before the change" by `identity_reset_at`, and cannot be put on the checklist again
   * (documentsBeforeReset). Returns whether a case was reset: no case, or a case with nothing on it (a draft with no
   * file, a rejected or expired one with none) already needs documents and stays as it is. `note` is what the
   * party's users read as the case's note.
   */
  async resetForIdentityChangeInTx(
    tx: DbTransaction,
    scope: TxScope,
    partyId: string,
    note: string,
  ): Promise<boolean> {
    const [existing] = await tx
      .select({ id: verificationCases.id })
      .from(verificationCases)
      .where(
        and(eq(verificationCases.tenantId, scope.tenantId), eq(verificationCases.partyId, partyId)),
      );
    if (existing === undefined) return false;
    const l = await this.lock(tx, scope.tenantId, existing.id);
    const items = checklistOf(l.row);
    // A file uploaded to the case but not yet on the checklist also counts: it was sent for the old details.
    const holdsDocuments =
      items.some((i) => i.documentId !== null) ||
      (await this.documents.listForOwner(scope, VERIFICATION_OWNER_TYPE, l.row.id, tx)).length > 0;
    if (l.row.status !== 'submitted' && l.row.status !== 'approved' && !holdsDocuments)
      return false;
    await this.preserveLegacyDecision(tx, l.row);
    const emptied = items.map((i) => ({
      key: i.key,
      required: i.required,
      status: 'missing' as const,
      documentId: null,
      expiresOn: null,
    }));
    const documentReview = l.row.reviewPolicy === 'document_review_v1';
    const actorUserId = this.caller.current().principal.userId;
    // The database's clock, as the files' own timestamps are: a file registered before this transaction is older.
    const dbNow = await tx.execute<{ at: Date }>(sql`select now() as at`);
    const resetAt = new Date(dbNow.rows[0]!.at);
    const updated = await updateVersioned(tx, verificationCases, l.row.id, l.row.version, {
      status: 'draft',
      checklist: emptied,
      reviewerUserId: null,
      decidedAt: null,
      reason: note,
      ...(documentReview && { reviewRound: l.row.reviewRound + 1 }),
      identityResetAt: resetAt,
      identityResetByUserId: actorUserId,
      updatedAt: this.now(),
    });
    await this.audit.record(tx, {
      action: 'verification.returned_to_draft',
      entityType: 'verification_case',
      entityId: updated.id,
      before: { status: l.row.status, version: l.row.version },
      after: { status: 'draft', version: updated.version },
      meta: { partyId, note },
    });
    return true;
  }

  // ---------------------------------------------------------------------------------------------- checklist

  /**
   * Puts one registered document on one checklist item. The document must belong to this case (it was
   * uploaded with owner type `verification_case` and this id), which also proves the caller could upload to it.
   * Editing a rejected case sends it back to draft so it can be submitted again.
   */
  async setChecklistItem(
    id: string,
    body: AttachVerificationDocumentBody,
  ): Promise<VerificationCaseDto> {
    const { scope, actor } = this.caller.current();
    this.assertKybWriter();
    const now = this.now();
    const cleanup: Awaited<ReturnType<DocumentsService['removeInTransaction']>> = [];
    const result = await withTx(this.db, scope, actor, async (tx) => {
      const l = await this.lock(tx, scope.tenantId, id);
      this.assertVisible(l.port.writePermission, scope, l);
      this.assertVisible('verification.read', scope, l);
      if (!isEditable(l.row.status)) {
        throw conflict(`A case in status ${l.row.status} cannot be changed`);
      }
      if (l.row.version !== body.expectedVersion) throw this.stale();
      // The key must be on this kind's checklist, and a key with a validity period needs its expiry.
      if (!checklistKeysFor(l.row.partyKind).includes(body.key)) {
        throw new UnprocessableEntityException({
          code: 'unprocessable',
          message: `${body.key} is not on the checklist of a ${l.row.partyKind} case`,
        });
      }
      if (requiresExpiry(body.key) && body.expiresOn === undefined) {
        throw new UnprocessableEntityException({
          code: 'unprocessable',
          message: `${body.key} needs expiresOn`,
        });
      }
      const versions = await this.documents.listForOwner(scope, VERIFICATION_OWNER_TYPE, id, tx);
      if (!versions.some((v) => v.documentId === body.documentId)) {
        throw new UnprocessableEntityException({
          code: 'unprocessable',
          message: 'documentId is not a document of this verification case',
        });
      }
      if (documentsBeforeReset(versions, l.row.identityResetAt).has(body.documentId)) {
        throw conflict(FILE_BEFORE_CHANGE_MESSAGE);
      }
      await assertNotInfected(tx, scope, [body.documentId]);
      const before = checklistOf(l.row);
      await this.preserveLegacyDecision(tx, l.row);
      const after = attachDocument(before, body.key, body.documentId, body.expiresOn ?? null);
      const slot = after.find((i) => i.key === body.key)!;
      if (l.row.reviewPolicy === 'document_review_v1') {
        slot.evidence = null;
        slot.review = null;
      }
      const old = before.find((i) => i.key === body.key)?.documentId;
      if (
        l.row.reviewPolicy === 'document_review_v1' &&
        old &&
        old !== body.documentId &&
        versions.some((v) => v.documentId === old) &&
        !after.some((i) => i.documentId === old)
      ) {
        cleanup.push(...(await this.documents.removeInTransaction(tx, scope, old)));
      }
      const reopen = l.row.status === 'rejected';
      const updated = await updateVersioned(tx, verificationCases, id, body.expectedVersion, {
        checklist: after,
        ...(reopen && {
          status: 'draft' as const,
          reviewerUserId: null,
          decidedAt: null,
          reason: null,
        }),
        updatedAt: now,
      });
      await this.audit.record(tx, {
        action: 'verification.checklist_updated',
        entityType: 'verification_case',
        entityId: id,
        before: before.find((i) => i.key === body.key) ?? null,
        after: after.find((i) => i.key === body.key),
        meta: { key: body.key, documentId: body.documentId, reopened: reopen },
      });
      return toVerificationCaseDto(updated);
    });
    await this.documents.cleanupRemoved(cleanup);
    return result;
  }

  /** Detaches the file from one checklist row, leaving the document and its versions on the case. */
  async removeChecklistDocument(
    id: string,
    body: RemoveVerificationDocumentBody,
  ): Promise<VerificationCaseDto> {
    const { scope, actor } = this.caller.current();
    this.assertKybWriter();
    return withTx(this.db, scope, actor, async (tx) => {
      const l = await this.lock(tx, scope.tenantId, id);
      this.assertVisible('verification.read', scope, l);
      this.assertVisible(l.port.writePermission, scope, l);
      if (!isEditable(l.row.status)) {
        throw conflict(`A case in status ${l.row.status} cannot be changed`);
      }
      if (l.row.version !== body.expectedVersion) throw this.stale();

      const checklist = checklistOf(l.row);
      const before = checklist.find((item) => item.key === body.key);
      if (before === undefined || before.documentId === null) {
        throw conflict('This checklist item has no attached document');
      }
      await this.preserveLegacyDecision(tx, l.row);
      const after = {
        ...before,
        evidence: null,
        review: null,
        status: 'missing' as const,
        documentId: null,
        expiresOn: null,
      };
      // Like replacing a file, removing one starts a fresh draft after a rejection.
      const reopen = l.row.status === 'rejected';
      const updated = await updateVersioned(tx, verificationCases, id, body.expectedVersion, {
        checklist: checklist.map((item) => (item === before ? after : item)),
        ...(reopen && {
          status: 'draft' as const,
          reviewerUserId: null,
          decidedAt: null,
          reason: null,
        }),
        updatedAt: this.now(),
      });
      await this.audit.record(tx, {
        action: 'verification.checklist_document_detached',
        entityType: 'verification_case',
        entityId: id,
        before,
        after,
        meta: { key: body.key, documentId: before.documentId, reopened: reopen },
      });
      return toVerificationCaseDto(updated);
    });
  }

  // -------------------------------------------------------------------------------------------------- submit

  /** Draft to submitted. Every required item must have a document; whether the scan passed is the reviewer's gate. */
  async submit(
    id: string,
    body?: { expectedVersion: number },
    idempotencyKey?: string,
  ): Promise<VerificationCaseDto> {
    const { scope, actor, principal } = this.caller.current();
    this.assertKybWriter();
    return withTx(this.db, scope, actor, async (tx) => {
      const l = await this.lock(tx, scope.tenantId, id);
      this.assertVisible(l.port.writePermission, scope, l);
      if (l.row.partyKind === 'vendor') {
        if (l.row.status !== 'draft') {
          throw conflict(`A case in status ${l.row.status} cannot be submitted`);
        }
        const missing = missingRequired(checklistOf(l.row));
        if (missing.length > 0) {
          throw conflict(`Required documents are missing: ${missing.join(', ')}`);
        }
        const updated = await updateVersioned(tx, verificationCases, id, l.row.version, {
          status: 'submitted',
          submittedByUserId: principal.userId,
          submittedAt: this.now(),
          reviewerUserId: null,
          decidedAt: null,
          reason: null,
          updatedAt: this.now(),
        });
        await this.audit.record(tx, {
          action: 'verification.submitted',
          entityType: 'verification_case',
          entityId: id,
          before: { status: 'draft', version: l.row.version },
          after: { status: 'submitted', version: updated.version, submittedBy: principal.userId },
        });
        return toVerificationCaseDto(updated);
      }
      this.assertVisible('verification.read', scope, l);
      const run = async () => {
        if (!idempotencyKey)
          throw new BadRequestException('Idempotency-Key is required for customer submission');
        if (l.row.reviewPolicy !== 'document_review_v1')
          throw conflict('Customer case requires document review activation');
        if (!body)
          throw new BadRequestException('expectedVersion is required for customer submission');
        if (l.row.version !== body.expectedVersion) throw this.stale();
        if (l.row.status !== 'draft') throw conflict('Only a draft can be submitted');
        const items = checklistOf(l.row);
        const missing = missingRequired(items);
        if (missing.length) throw conflict(`Required documents are missing: ${missing.join(', ')}`);
        const versions = await this.documents.listForOwner(scope, VERIFICATION_OWNER_TYPE, id, tx);
        const rejected = await tx
          .select()
          .from(verificationReviewEvents)
          .where(
            and(
              eq(verificationReviewEvents.tenantId, scope.tenantId),
              eq(verificationReviewEvents.caseId, id),
              eq(verificationReviewEvents.kind, 'item_decided'),
              eq(verificationReviewEvents.decision, 'reject'),
            ),
          );
        for (const item of items) {
          item.review = null;
          item.evidence = null;
          if (!item.documentId) continue;
          const v = versions
            .filter((v) => v.documentId === item.documentId)
            .sort((a, b) => b.version - a.version)[0];
          if (!v || v.status === 'rejected')
            throw conflict('Evidence is unavailable; replace or remove it');
          if (
            rejected.some(
              (r) => VerificationEvidenceSchema.parse(r.evidence).documentVersionId === v.id,
            )
          )
            throw conflict('Rejected evidence must be replaced with a new file version');
          if (item.expiresOn && item.expiresOn <= kathmanduDateString(this.now()))
            throw conflict('Evidence has expired');
          item.status = 'provided';
          item.evidence = {
            documentId: v.documentId,
            documentVersionId: v.id,
            versionNumber: v.version,
            expiresOn: item.expiresOn,
          };
        }
        const updated = await updateVersioned(tx, verificationCases, id, body.expectedVersion, {
          status: 'submitted',
          checklist: items,
          reviewRound: l.row.reviewRound + 1,
          submittedByUserId: principal.userId,
          submittedAt: this.now(),
          reviewerUserId: null,
          decidedAt: null,
          reason: null,
          updatedAt: this.now(),
        });
        await this.audit.record(tx, {
          action: 'verification.submitted',
          entityType: 'verification_case',
          entityId: id,
          after: { version: updated.version },
        });
        return { status: 200, response: toVerificationCaseDto(updated) };
      };
      return idempotencyKey
        ? (
            await withIdempotency(
              tx,
              { command: 'verification.submit', key: idempotencyKey, body: { id, ...body } },
              run,
            )
          ).response
        : (await run()).response;
    });
  }

  // ------------------------------------------------------------------------------------------------ decision

  /**
   * Approve or reject a submitted case. With an Idempotency-Key, a retry of the same decision returns the first
   * answer instead of deciding twice; the same key with another body is a 422.
   */
  async decide(
    id: string,
    body: DecisionBody,
    idempotencyKey?: string,
  ): Promise<VerificationCaseDto> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.now();

    const run = async (
      tx: DbTransaction,
    ): Promise<{ status: number; response: VerificationCaseDto }> => {
      const l = await this.lock(tx, scope.tenantId, id);
      // Scope first (404), then the rest: someone who may not review learns nothing about the case.
      this.assertVisible('verification.review', scope, l);
      if (l.row.version !== body.expectedVersion) throw this.stale();
      if (l.row.status !== 'submitted') {
        throw conflict(`A case in status ${l.row.status} cannot be decided`);
      }
      if (l.row.submittedByUserId === principal.userId) throw separationOfDuties();

      const items = checklistOf(l.row);
      const documentReview = l.row.partyKind === 'customer';
      if (documentReview && l.row.reviewPolicy !== 'document_review_v1')
        throw conflict('Customer case requires document review activation');
      const approve = body.decision === 'approve';
      if (approve) {
        if (documentReview) {
          if (
            !items.some((i) => i.required) ||
            items.some((i) => i.required && !i.documentId) ||
            items.some(
              (i) =>
                i.documentId && (i.status !== 'accepted' || i.review?.round !== l.row.reviewRound),
            )
          )
            throw conflict('Every supplied document needs explicit approval');
          for (const item of items.filter((i) => i.documentId)) {
            await this.assertEvidence(tx, scope, l.row, item, true);
            const [review] = await tx
              .select()
              .from(verificationReviewEvents)
              .where(
                and(
                  eq(verificationReviewEvents.tenantId, scope.tenantId),
                  eq(verificationReviewEvents.caseId, id),
                  eq(verificationReviewEvents.id, item.review!.id),
                  eq(verificationReviewEvents.round, l.row.reviewRound),
                  eq(verificationReviewEvents.itemKey, item.key),
                  eq(verificationReviewEvents.decision, 'approve'),
                ),
              );
            if (
              !review ||
              review.documentVersionId !== item.evidence?.documentVersionId ||
              VerificationEvidenceSchema.parse(review.evidence).expiresOn !== item.expiresOn
            )
              throw conflict(
                'Every supplied document needs an immutable approval for this evidence',
              );
          }
        }
        const missing = missingRequired(items);
        if (missing.length > 0) {
          throw conflict(`Required documents are missing: ${missing.join(', ')}`);
        }
        const versions = await this.documents.listForOwner(scope, VERIFICATION_OWNER_TYPE, id, tx);
        const unusable = documentProblems(items, versions);
        const allClean =
          !documentReview ||
          (await this.documents.allClean(scope, VERIFICATION_OWNER_TYPE, id, tx));
        if (unusable.length > 0 || !allClean) {
          throw conflict(
            `Documents are not all clean${unusable.length > 0 ? `: ${unusable.join(', ')}` : ''}`,
          );
        }
      }

      const updated = await updateVersioned(tx, verificationCases, id, body.expectedVersion, {
        status: approve ? 'approved' : 'rejected',
        reviewerUserId: principal.userId,
        decidedAt: now,
        reason: body.comment ?? null,
        checklist: approve && !documentReview ? acceptProvided(items) : items,
        updatedAt: now,
      });
      if (documentReview)
        await this.journal(tx, updated, null, body.decision, body.comment ?? null);
      await this.audit.record(tx, {
        action: approve ? 'verification.approved' : 'verification.rejected',
        entityType: 'verification_case',
        entityId: id,
        before: { status: 'submitted', version: l.row.version },
        after: { status: updated.status, version: updated.version, reviewedBy: principal.userId },
        meta: { comment: body.comment ?? null },
      });
      return { status: 200, response: toVerificationCaseDto(updated) };
    };

    return withTx(this.db, scope, actor, async (tx) => {
      const visible = await this.lock(tx, scope.tenantId, id);
      this.assertVisible('verification.review', scope, visible);
      if (visible.row.submittedByUserId === principal.userId) throw separationOfDuties();
      if (idempotencyKey === undefined) return (await run(tx)).response;
      const result = await withIdempotency(
        tx,
        // The id is part of the hashed request: the same key on another case is a different request.
        { command: 'verification.decision', key: idempotencyKey, body: { id, ...body } },
        run,
      );
      return result.response;
    });
  }

  async reviewItem(
    id: string,
    key: ChecklistItem['key'],
    body: ReviewVerificationItemBody,
    retryKey: string,
  ): Promise<VerificationCaseDto> {
    const { scope, actor, principal } = this.caller.current();
    return withTx(this.db, scope, actor, async (tx) => {
      const l = await this.lock(tx, scope.tenantId, id);
      this.assertVisible('verification.review', scope, l);
      if (l.row.submittedByUserId === principal.userId) throw separationOfDuties();
      return (
        await withIdempotency(
          tx,
          { command: 'verification.item_decision', key: retryKey, body: { id, key, ...body } },
          async () => {
            if (l.row.version !== body.expectedVersion) throw this.stale();
            if (l.row.reviewPolicy !== 'document_review_v1' || l.row.status !== 'submitted')
              throw conflict('Only submitted document-review cases can be reviewed');
            const items = checklistOf(l.row),
              item = items.find((i) => i.key === key);
            if (!item || item.status !== 'provided')
              throw conflict('This document is missing or already decided');
            await this.assertEvidence(tx, scope, l.row, item, body.decision === 'approve');
            item.status = body.decision === 'approve' ? 'accepted' : 'rejected';
            const event = await this.journal(
              tx,
              { ...l.row, version: l.row.version + 1 },
              item,
              body.decision,
              body.decision === 'reject' ? body.comment : null,
            );
            item.review = event;
            const updated = await updateVersioned(tx, verificationCases, id, body.expectedVersion, {
              checklist: items,
              updatedAt: this.now(),
            });
            await this.audit.record(tx, {
              action:
                body.decision === 'approve'
                  ? 'verification.item_approved'
                  : 'verification.item_rejected',
              entityType: 'verification_case',
              entityId: id,
              meta: { key, reviewId: event.id },
            });
            return { status: 200, response: toVerificationCaseDto(updated) };
          },
        )
      ).response;
    });
  }

  async removeLooseDocument(id: string, documentId: string): Promise<void> {
    const { scope, actor } = this.caller.current();
    const cleanup = await withTx(this.db, scope, actor, async (tx) => {
      const loaded = await this.lock(tx, scope.tenantId, id);
      this.assertVisible('verification.read', scope, loaded);
      this.assertVisible('customer.write', scope, loaded);
      if (loaded.row.partyKind !== 'customer') throw notFound('Verification case');
      if (
        !isEditable(loaded.row.status) ||
        checklistOf(loaded.row).some((i) => i.documentId === documentId)
      )
        throw conflict('Only unattached files in an editable case can be removed');
      const versions = await this.documents.listForOwner(scope, VERIFICATION_OWNER_TYPE, id, tx);
      if (!versions.some((v) => v.documentId === documentId)) throw notFound('Document');
      if (documentsBeforeReset(versions, loaded.row.identityResetAt).has(documentId)) {
        throw conflict('A file from before the details changed stays on the case as history');
      }
      return this.documents.removeInTransaction(tx, scope, documentId);
    });
    await this.documents.cleanupRemoved(cleanup);
  }

  async detachItem(
    id: string,
    key: ChecklistItem['key'],
    body: { expectedVersion: number },
    retryKey: string,
  ): Promise<VerificationCaseDto> {
    const { scope, actor } = this.caller.current();
    const cleanup: Awaited<ReturnType<DocumentsService['removeInTransaction']>> = [];
    const result = await withTx(this.db, scope, actor, async (tx) => {
      const l = await this.lock(tx, scope.tenantId, id);
      this.assertVisible('verification.read', scope, l);
      this.assertVisible('customer.write', scope, l);
      if (l.row.partyKind !== 'customer' || l.row.reviewPolicy !== 'document_review_v1')
        throw conflict('Document detach requires a customer document-review case');
      return (
        await withIdempotency(
          tx,
          { command: 'verification.detach', key: retryKey, body: { id, key, ...body } },
          async () => {
            if (l.row.version !== body.expectedVersion) throw this.stale();
            if (!isEditable(l.row.status))
              throw conflict('Reject the case before correcting evidence');
            const items = checklistOf(l.row),
              item = items.find((i) => i.key === key);
            if (!item?.documentId) throw conflict('No document attached');
            await this.preserveLegacyDecision(tx, l.row);
            const old = item.documentId;
            item.documentId = null;
            item.status = 'missing';
            item.expiresOn = null;
            item.evidence = null;
            item.review = null;
            if (!items.some((i) => i.documentId === old)) {
              const versions = await this.documents.listForOwner(
                scope,
                VERIFICATION_OWNER_TYPE,
                id,
                tx,
              );
              if (versions.some((v) => v.documentId === old))
                cleanup.push(...(await this.documents.removeInTransaction(tx, scope, old)));
            }
            const updated = await updateVersioned(tx, verificationCases, id, body.expectedVersion, {
              status: 'draft',
              checklist: items,
              reviewerUserId: null,
              decidedAt: null,
              reason: null,
              updatedAt: this.now(),
            });
            await this.audit.record(tx, {
              action: 'verification.checklist_detached',
              entityType: 'verification_case',
              entityId: id,
              meta: { key },
            });
            return { status: 200, response: toVerificationCaseDto(updated) };
          },
        )
      ).response;
    });
    await this.documents.cleanupRemoved(cleanup);
    return result;
  }

  async reviewHistory(
    id: string,
    query: { before?: { at: string; id: string } | undefined; limit: number },
  ): Promise<VerificationReviewHistory> {
    const { scope } = this.caller.current();
    const l = await this.load(this.db, scope.tenantId, id);
    if (!l) throw notFound('Verification case');
    this.assertVisible('verification.read', scope, l);
    const rows = await this.db
      .select({
        ...getTableColumns(verificationReviewEvents),
        reviewerName: users.displayName,
        reviewerAvatarDocumentId: users.avatarDocumentId,
      })
      .from(verificationReviewEvents)
      .innerJoin(
        users,
        and(
          eq(users.tenantId, verificationReviewEvents.tenantId),
          eq(users.id, verificationReviewEvents.actorUserId),
        ),
      )
      .where(
        and(
          eq(verificationReviewEvents.tenantId, scope.tenantId),
          eq(verificationReviewEvents.caseId, id),
          query.before
            ? or(
                lt(verificationReviewEvents.occurredAt, new Date(query.before.at)),
                and(
                  eq(verificationReviewEvents.occurredAt, new Date(query.before.at)),
                  lt(verificationReviewEvents.id, query.before.id),
                ),
              )
            : undefined,
        ),
      )
      .orderBy(desc(verificationReviewEvents.occurredAt), desc(verificationReviewEvents.id))
      .limit(query.limit + 1);
    return VerificationReviewHistorySchema.parse({
      items: rows.slice(0, query.limit).map((r) => ({
        ...r,
        itemKey: r.itemKey,
        reviewedBy: r.actorUserId,
        reviewedAt: r.occurredAt.toISOString(),
      })),
      nextCursor:
        rows.length > query.limit
          ? Buffer.from(
              JSON.stringify({
                at: rows[query.limit - 1]!.occurredAt.toISOString(),
                id: rows[query.limit - 1]!.id,
              }),
            ).toString('base64url')
          : null,
    });
  }

  private async assertEvidence(
    tx: DbTransaction,
    scope: TxScope,
    row: CaseRow,
    item: ChecklistItem,
    approve: boolean,
  ): Promise<void> {
    const binding = item.evidence;
    if (!binding || binding.documentId !== item.documentId || binding.expiresOn !== item.expiresOn)
      throw conflict('Evidence is unavailable; correct and resubmit');
    const versions = await this.documents.listForOwner(scope, VERIFICATION_OWNER_TYPE, row.id, tx);
    const latest = versions
      .filter((v) => v.documentId === item.documentId)
      .sort((a, b) => b.version - a.version)[0];
    if (!latest || latest.id !== binding.documentVersionId)
      throw conflict('Bound evidence is unavailable or has changed');
    if (
      approve &&
      (latest.status !== 'clean' ||
        !latest.sha256 ||
        !latest.scannedAt ||
        (item.expiresOn !== null && item.expiresOn <= kathmanduDateString(this.now())))
    )
      throw conflict('Evidence must be clean and unexpired');
  }

  private async journal(
    tx: DbTransaction,
    row: CaseRow,
    item: ChecklistItem | null,
    decision: 'approve' | 'reject',
    comment: string | null,
    legacy = false,
  ) {
    const { principal, scope } = this.caller.current();
    const [entry] = await tx
      .insert(verificationReviewEvents)
      .values({
        tenantId: row.tenantId,
        caseId: row.id,
        caseVersion: row.version,
        round: row.reviewRound,
        kind: legacy ? 'legacy_case_decided' : item ? 'item_decided' : 'case_decided',
        itemKey: item?.key ?? null,
        decision,
        comment,
        actorUserId: legacy ? row.reviewerUserId! : principal.userId,
        occurredAt: legacy ? row.decidedAt! : this.now(),
        evidence: item?.evidence ?? null,
        evidenceOrganizationId: item ? scope.organizationId : null,
        documentId: item?.evidence?.documentId ?? null,
        documentVersionId: item?.evidence?.documentVersionId ?? null,
      })
      .returning();
    return {
      id: entry!.id,
      decision,
      comment,
      reviewedBy: entry!.actorUserId,
      reviewedAt: entry!.occurredAt.toISOString(),
      round: row.reviewRound,
      evidence: item?.evidence ?? null,
    };
  }

  private async preserveLegacyDecision(tx: DbTransaction, row: CaseRow): Promise<void> {
    if (
      row.partyKind !== 'customer' ||
      row.reviewPolicy !== 'case_review_v0' ||
      !row.reviewerUserId ||
      !row.decidedAt
    )
      return;
    const [existing] = await tx
      .select()
      .from(verificationReviewEvents)
      .where(
        and(
          eq(verificationReviewEvents.tenantId, row.tenantId),
          eq(verificationReviewEvents.caseId, row.id),
          eq(verificationReviewEvents.caseVersion, row.version),
        ),
      );
    if (!existing)
      await this.journal(
        tx,
        row,
        null,
        row.status === 'rejected' ? 'reject' : 'approve',
        row.reason,
        true,
      );
  }

  // ----------------------------------------------------------------------------------------------- helpers

  private stale(): ConflictException {
    return conflict('This record was changed by someone else; reload it and try again');
  }

  /**
   * 403 unless the caller holds the write permission of at least one registered party kind. Runs before any read,
   * so a caller with neither customer.write nor vendor.write gets the same answer for a real and an unknown id.
   * The record check (assertVisible with the case's own kind) still follows.
   */
  private assertKybWriter(): void {
    let refusal: unknown = new ForbiddenException({
      code: 'forbidden',
      message: 'Forbidden',
      reason: 'no_permission',
    });
    for (const kind of VERIFICATION_PARTY_KINDS) {
      const port = this.partyOwners.find(kind);
      if (port === undefined) continue;
      try {
        this.authz.assert(port.writePermission);
        return;
      } catch (error) {
        refusal = error;
      }
    }
    throw refusal;
  }

  private assertVisible(action: Permission, scope: TxScope, l: Loaded): void {
    try {
      this.authz.assert(action, caseRef(scope, l));
    } catch (error) {
      hideOutOfScope(error, 'Verification case');
    }
  }

  /**
   * The cases `p` may read under verification.read, as SQL: the twin of mayRead (can() on caseRef) for every row.
   * `all` is the whole tenant for staff; `own` is a case whose party the caller owns (through each kind's port);
   * a portal caller reaches only the case of its own party, of its own kind. Anything else matches nothing.
   */
  private readableWhere(tenantId: string, p: Principal): SQL {
    const none = sql`false`;
    if (p.status !== 'active') return none;
    const myParty = (): SQL => {
      const kind = p.orgKind === 'customer' || p.orgKind === 'vendor' ? p.orgKind : undefined;
      if (kind === undefined || p.partyId === null || p.partyId === '') return none;
      return and(
        eq(verificationCases.partyKind, kind),
        eq(verificationCases.partyId, p.partyId),
      ) as SQL;
    };
    switch (p.grants.get('verification.read')) {
      case 'all':
        return p.orgKind === 'staff' ? sql`true` : myParty();
      case 'customer_org':
        return myParty();
      case 'own': {
        const arms = this.partyOwners
          .all()
          .map((port) =>
            and(
              eq(verificationCases.partyKind, port.kind),
              inArray(verificationCases.partyId, port.ownedBy(this.db, tenantId, p.userId)),
            ),
          );
        return arms.length === 0 ? none : (or(...arms) as SQL);
      }
      default:
        return none;
    }
  }

  private mayRead(scope: TxScope, l: Loaded): boolean {
    try {
      this.authz.assert('verification.read', caseRef(scope, l));
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  }

  /** The case of this tenant, with its party's owner. `lock` keeps the row until the transaction ends. */
  private async load(
    q: Q,
    tenantId: string,
    id: string,
    lock?: 'update' | 'share',
  ): Promise<Loaded | undefined> {
    const key = and(eq(verificationCases.tenantId, tenantId), eq(verificationCases.id, id));
    // The case row is read (and locked) on its own table, then its party's owner is read through the port.
    const read = q.select().from(verificationCases).where(key);
    const [row] = await (lock === undefined ? read : read.for(lock));
    if (row === undefined) return undefined;
    return (await this.withOwners(q, tenantId, [row]))[0];
  }

  /**
   * The cases with their party's owner, one query per party kind. A case whose kind has no adapter, or whose party
   * the adapter does not find, is left out: the same answer the customers inner join gave for a missing customer.
   */
  private async withOwners(q: Q, tenantId: string, rows: readonly CaseRow[]): Promise<Loaded[]> {
    const owners = new Map<VerificationPartyKind, ReadonlyMap<string, string | null>>();
    for (const kind of new Set(rows.map((r) => r.partyKind))) {
      const port = this.partyOwners.find(kind);
      if (port === undefined) continue;
      const ids = rows.filter((r) => r.partyKind === kind).map((r) => r.partyId);
      owners.set(kind, await port.ownersOf(q, tenantId, ids));
    }
    const loaded: Loaded[] = [];
    for (const row of rows) {
      const port = this.partyOwners.find(row.partyKind);
      const found = owners.get(row.partyKind);
      if (port === undefined || found === undefined || !found.has(row.partyId)) continue;
      loaded.push({ row, partyOwnerUserId: found.get(row.partyId) ?? null, port });
    }
    return loaded;
  }

  private async lock(tx: DbTransaction, tenantId: string, id: string): Promise<Loaded> {
    const l = await this.load(tx, tenantId, id, 'update');
    if (l === undefined) throw notFound('Verification case');
    return l;
  }
}
