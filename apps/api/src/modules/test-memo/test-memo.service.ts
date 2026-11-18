// TestMemoService: the internal memo, the first document type that flowed through the whole kernel. Serves the NFRs:
// - "no gaps in a numbered series": the number is taken inside the memo's own transaction, so a failed
//   create hands the number back;
// - "separation of duties": everyone who touched the memo (owner, editors, uploaders of its attachments and
//   the submitter) goes to the approval request, which refuses their approval;
// - "what was approved is what was seen": the attachments (normally none) are frozen into the hashed snapshot
//   at submit, and the owner policy refuses new uploads until the memo is editable again;
// - "no double decisions": submit and update lock the memo row (FOR UPDATE), so a second click waits and then
//   sees the new status.
// Two kinds of memo share the table:
// - a TEMPLATE memo (row.template is set) is internal correspondence. It carries no money: the amount columns hold
//   the compatibility value NPR 0.00 and nothing routes on them. Its approval route is exactly the people the author
//   named (each recommender in order, then the approver), planned by the engine so separation of duties applies;
// - a legacy memo (no template) is the P1 test memo. It still has an amount, an FX-frozen NPR value and the
//   workflow's role steps with amount thresholds, so historical records read and route as they did.
// From P2 the Workspace creates only template memos. The module stays: its audit rows and old memos are history.
// - "no history is lost": a creator discards an unsubmitted memo softly (discarded_at). The row keeps its number,
//   audit trail, approval history and attachment files, but every read and write here skips it, so it cannot be
//   listed, opened, edited, submitted or attached to, and its files stop being served.
import {
  type CreateMemoBody,
  type MemoDirectory,
  type MemoPerson,
  ROLE_KEYS,
  type RoleKey,
  type MemoList,
  type MemoListQuery,
  type MemoTemplateSnapshot,
  type DocumentVersionDto,
  type MemoDto,
  type Money,
  type Permission,
  type RoutePlan,
} from '@bos/contracts';
import {
  approvalRequests,
  departments,
  idpOrgs,
  organizations,
  userEntities,
  users,
  parties,
  scoped,
  testMemos,
  userRoles,
} from '@bos/db';
import { Dec } from '@bos/locale';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  or,
  notInArray,
  sql,
  type SQL,
} from 'drizzle-orm';

import { APPROVALS_CLOCK, type Clock } from '../approvals/ports';
import {
  ApprovalsService,
  type ExplicitRouteStep,
  type SubmitInput,
} from '../approvals/requests.service';
import { type Principal, type ResourceRef } from '../../platform/authz/can';
import { can } from '../../platform/authz/can';
import { AuthzService } from '../../platform/authz/authz.service';
import { RoleCache } from '../../platform/authz/role-cache';
import { DB, type Db, type DbTransaction } from '../../platform/db/db.module';
import { withTx, type TxScope } from '../../platform/db/tx';
import { type DocumentOwnerPolicy } from '../../platform/documents/documents.ports';
import { DocumentsService } from '../../platform/documents/documents.service';
import { personLabel } from '../../platform/users/person-names';
import { readTxContext } from '../../platform/documents/tx-context';
import { NotifyService } from '../../platform/notify/notify.service';
import { MoneyService } from '../../platform/settings/money.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import { TestMemoCaller } from './test-memo.caller';
import {
  MEMO_OWNER_TYPE,
  type MemoApprovalSummary,
  type MemoDetailDto,
  type SubmitMemoResult,
  type UpdateMemoBody,
} from './test-memo.types';

type MemoRow = typeof testMemos.$inferSelect;
type Q = Db | DbTransaction;

/** The numbering series key; `numbering.memo_prefix` in settings is the display prefix of the same series. */
const MEMO_SERIES = 'MEMO';
/** Only these two states may be edited or submitted: a submitted memo is frozen for the approvers. */
const EDITABLE: readonly MemoRow['status'][] = ['draft', 'returned'];

const iso = (d: Date): string => d.toISOString();

/**
 * What the NOT NULL money columns hold for a memo that carries no money (internal correspondence): NPR 0.00 at
 * the identity rate, taken through MoneyService like any other amount. Nothing routes on it or shows it as a
 * figure; it exists only so the table's constraints stay satisfied without a migration.
 */
const NO_MONEY: Money = { amount: '0.00', currency: 'NPR' };
/** A memo that was not discarded. Added to every lookup, so a discarded memo is as absent as a random id. */
const live = () => isNull(testMemos.discardedAt);

interface ListCursor {
  createdAt: string;
  id: string;
}
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encodeCursor = (c: ListCursor): string =>
  Buffer.from(JSON.stringify([c.createdAt, c.id])).toString('base64url');
/** An unreadable or forged cursor is the caller's mistake: 400, never a database error. */
function decodeCursor(raw: string): ListCursor {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(parsed) &&
      parsed.length === 2 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      CURSOR_TIME.test(parsed[0]) &&
      CURSOR_ID.test(parsed[1])
    ) {
      return { createdAt: parsed[0], id: parsed[1] };
    }
  } catch {
    // fall through to the 400 below
  }
  throw new BadRequestException({ code: 'bad_request', message: 'cursor is not valid' });
}

const memoNotFound = () => new NotFoundException({ code: 'not_found', message: 'Memo not found' });
const notAllClean = () =>
  new ConflictException({ code: 'conflict', message: 'attachments are not all clean' });

/** One attachment as the approvers saw it: the exact version and its content hash. */
interface FrozenAttachment {
  documentId: string;
  versionId: string;
  filename: string;
  sha256: string | null;
  detectedMime: string | null;
}

/**
 * The attachment of each document that a submit freezes: its newest version that was not rejected, the same
 * rule as DocumentsService.allClean. Undefined when one of them is not clean (an upload raced the submit).
 */
function frozenAttachments(versions: DocumentVersionDto[]): FrozenAttachment[] | undefined {
  const latest = new Map<string, DocumentVersionDto>();
  for (const v of versions) {
    if (v.status === 'rejected') continue;
    const seen = latest.get(v.documentId);
    if (seen === undefined || v.version > seen.version) latest.set(v.documentId, v);
  }
  const chosen = [...latest.values()];
  if (!chosen.every((v) => v.status === 'clean')) return undefined;
  return chosen
    .sort((a, b) => (a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0))
    .map((v) => ({
      documentId: v.documentId,
      versionId: v.id,
      filename: v.filename,
      sha256: v.sha256,
      detectedMime: v.detectedMime,
    }));
}

/**
 * The approval route of a template memo: each recommender in the order the author listed them, then the approver.
 * One function for submit and for the route preview, so what the author sees before submitting is what submit builds.
 */
export function explicitRouteOf(template: MemoTemplateSnapshot): ExplicitRouteStep[] {
  return [
    ...template.recommenders.map((p, i) => ({
      userId: p.userId,
      reason: `Selected recommender ${i + 1}`,
    })),
    { userId: template.approvedBy.userId, reason: 'Selected approver' },
  ];
}

export function toMemoDto(row: MemoRow): MemoDto {
  return {
    template: row.template,
    id: row.id,
    number: row.number,
    title: row.title,
    body: row.body,
    amount: row.amount,
    currency: row.currency as MemoDto['currency'],
    amountNpr: row.amountNpr,
    // numeric(18,6) comes back as '1.600000'; drop the trailing zeros like MoneyService does.
    fxRate: new Dec(row.fxRate).toFixed(),
    fxSource: row.fxSource,
    fxDate: row.fxDate,
    status: row.status,
    ownerUserId: row.ownerUserId,
    departmentId: row.departmentId,
    customerPartyId: row.customerPartyId,
    editorUserIds: row.editorUserIds,
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** What authz and the documents module need to decide about one memo (record scope columns of section 5). */
export function memoRef(row: MemoRow): ResourceRef {
  return {
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    ownerUserId: row.ownerUserId,
    departmentId: row.departmentId,
    customerPartyId: row.customerPartyId,
  };
}

@Injectable()
export class TestMemoService implements OnModuleInit {
  private readonly log = new Logger(TestMemoService.name);

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly numbering: NumberingService,
    private readonly money: MoneyService,
    private readonly documents: DocumentsService,
    private readonly approvals: ApprovalsService,
    private readonly authz: AuthzService,
    private readonly roleCache: RoleCache,
    private readonly caller: TestMemoCaller,
    @Inject(APPROVALS_CLOCK) private readonly clock: Clock,
    // Optional: a missing notify module only slows delivery (the 5 s drain still sends), it never fails a submit.
    @Optional() private readonly notify?: NotifyService,
  ) {}

  /**
   * Both registries throw on a duplicate, so this runs once, when the module starts. onDecided is only called from
   * ApprovalsService.act, which is an API route, so the worker never needs the registration.
   */
  onModuleInit(): void {
    // Typed with canAttach spelled out, so this compiles whether or not the port declares the optional hook yet.
    const policy: DocumentOwnerPolicy & {
      canAttach(scope: TxScope, ownerId: string): Promise<boolean>;
    } = {
      ownerType: MEMO_OWNER_TYPE,
      resource: async (scope, ownerId) => {
        const row = await this.find(this.db, scope, ownerId);
        return row === undefined || !this.currentContentVisible(row) ? null : memoRef(row);
      },
      // A submitted memo is frozen for the approvers, files included: the snapshot names the exact versions,
      // so an upload after submit would sit on the memo unseen by anyone who approved it.
      canAttach: async (scope, ownerId) => {
        const row = await this.find(this.db, scope, ownerId);
        return row !== undefined && EDITABLE.includes(row.status);
      },
    };
    this.documents.registerOwner(policy);
    this.approvals.registerSubject({
      documentType: MEMO_OWNER_TYPE,
      onDecided: (tx, documentId, outcome) => this.onDecided(tx, documentId, outcome),
      // The requester opens the memo itself when its approval is decided.
      link: (_tx, documentId) => `/memos/${documentId}`,
    });
  }

  async directory(): Promise<MemoDirectory> {
    const { scope, principal } = this.caller.current();
    this.authz.assert('memo.create');
    if (principal.orgKind !== 'staff' || principal.status !== 'active')
      throw new ForbiddenException();
    const [entity] = await this.db
      .select()
      .from(organizations)
      .where(scoped(scope).where(organizations));
    if (!entity) throw new ForbiddenException();
    const depts = await this.db
      .select({ id: departments.id, name: departments.name })
      .from(departments)
      .where(scoped(scope).where(departments));
    const people = await this.db
      .select({
        userId: users.id,
        displayName: users.displayName,
        email: users.email,
        jobTitle: userEntities.jobTitle,
        departmentId: userEntities.departmentId,
      })
      .from(userEntities)
      .innerJoin(
        users,
        and(eq(users.tenantId, userEntities.tenantId), eq(users.id, userEntities.userId)),
      )
      .innerJoin(idpOrgs, and(eq(idpOrgs.tenantId, users.tenantId), eq(idpOrgs.id, users.idpOrgId)))
      .where(
        and(
          scoped(scope).where(userEntities),
          eq(users.status, 'active'),
          // The authoritative mirror takes email only from ZITADEL human.email; machine users have null.
          isNotNull(users.email),
          ne(users.email, ''),
          eq(idpOrgs.kind, 'staff'),
        ),
      );
    const named = people.flatMap((p) => {
      const name = personLabel(p.displayName, p.email);
      return name ? [{ ...p, name }] : [];
    });
    const approvers = await this.approverIds(
      scope,
      named.map((p) => p.userId),
    );
    return {
      organizationId: entity.id,
      organizationName: entity.legalName,
      currentUserId: principal.userId,
      departmentId: principal.departmentId,
      departments: depts,
      people: named.map((p) => ({
        userId: p.userId,
        name: p.name,
        jobTitle: p.jobTitle,
        department: depts.find((d) => d.id === p.departmentId)?.name ?? null,
        canApprove: approvers.has(p.userId),
      })),
    };
  }

  /**
   * The users among `ids` who may decide approvals right now: their roles in this entity (the user_roles mirror,
   * narrowed by the membership's role_keys exactly as the tenancy interceptor narrows a token's roles) hold an
   * `approvals.requests.act` grant in the live role_permissions rows (RoleCache). That is the check the decide
   * route's @Can runs, so a person named here can actually reach the decision.
   */
  private async approverIds(scope: TxScope, ids: readonly string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.db
      .select({
        userId: userRoles.userId,
        roleKey: userRoles.roleKey,
        allowed: userEntities.roleKeys,
      })
      .from(userRoles)
      .innerJoin(
        userEntities,
        and(
          eq(userEntities.tenantId, userRoles.tenantId),
          eq(userEntities.userId, userRoles.userId),
          eq(userEntities.organizationId, scope.organizationId),
        ),
      )
      .where(and(eq(userRoles.tenantId, scope.tenantId), inArray(userRoles.userId, [...ids])));
    const rolesOf = new Map<string, RoleKey[]>();
    for (const r of rows) {
      if (r.allowed !== null && !r.allowed.includes(r.roleKey)) continue;
      if (!(ROLE_KEYS as readonly string[]).includes(r.roleKey)) continue;
      rolesOf.set(r.userId, [...(rolesOf.get(r.userId) ?? []), r.roleKey as RoleKey]);
    }
    const out = new Set<string>();
    for (const [userId, roles] of rolesOf) {
      const grants = await this.roleCache.grantsFor(scope.tenantId, scope.organizationId, roles);
      if (grants.has('approvals.requests.act')) out.add(userId);
    }
    return out;
  }

  private async templateSnapshot(
    input: NonNullable<CreateMemoBody['template']>,
  ): Promise<MemoTemplateSnapshot> {
    const directory = await this.directory();
    // Prepared attribution is the actual actor. Delegated authorship needs its own permission.
    if (input.preparedByUserId !== directory.currentUserId)
      throw new ForbiddenException('Prepared by must be the signed-in staff member');
    const department = directory.departments.find((d) => d.id === input.departmentId);
    if (!department) throw new BadRequestException('Choose a department in the active company');
    // Only the printed fields go into the snapshot: `canApprove` is a live directory fact, not part of the memo.
    const person = (id: string): MemoPerson => {
      const p = directory.people.find((p) => p.userId === id);
      if (!p)
        throw new BadRequestException('Selected staff member is unavailable in the active company');
      return { userId: p.userId, name: p.name, jobTitle: p.jobTitle, department: p.department };
    };
    return {
      organizationId: directory.organizationId,
      organizationName: directory.organizationName,
      departmentId: department.id,
      departmentName: department.name,
      date: input.date,
      closing: input.closing,
      preparedBy: person(input.preparedByUserId),
      recommenders: input.recommenderUserIds.map(person),
      approvedBy: person(input.approvedByUserId),
    };
  }

  // ----------------------------------------------------------------------------------------------- create

  async create(body: CreateMemoBody): Promise<MemoDto> {
    const { scope, actor, principal } = this.caller.current();
    // The contract already refuses this at the edge; repeated here so a direct service call cannot store a
    // legacy memo with an invented amount.
    if (body.template === undefined && (body.amount === undefined || body.currency === undefined)) {
      throw new BadRequestException(
        'amount and currency are required for a memo without a template',
      );
    }
    const template = body.template ? await this.templateSnapshot(body.template) : undefined;
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      // The FK also refuses a vendor or foreign party, but as a 500; name the problem as a 400 instead.
      if (body.customerPartyId) {
        const [party] = await tx
          .select({ id: parties.id })
          .from(parties)
          .where(
            and(
              eq(parties.tenantId, scope.tenantId),
              eq(parties.id, body.customerPartyId),
              eq(parties.kind, 'customer'),
            ),
          )
          .limit(1);
        if (!party) {
          throw new BadRequestException({
            code: 'bad_request',
            message: 'customerPartyId is not a customer of this tenant',
          });
        }
      }
      const number = await this.numbering.next(tx, MEMO_SERIES, now);
      // A template memo may omit the money (the contract allows it only then): store NPR 0.00. A legacy memo
      // always sends both; the contract refuses it otherwise.
      const money: Money = {
        amount: body.amount ?? NO_MONEY.amount,
        currency: body.currency ?? NO_MONEY.currency,
      };
      const snap = await this.money.toNprSnapshot(tx, scope, money, now);
      const [row] = await tx
        .insert(testMemos)
        .values(
          scoped(scope).values({
            template,
            number,
            title: body.title,
            body: body.body,
            amount: money.amount,
            currency: money.currency,
            amountNpr: snap.amountNpr,
            fxRate: snap.rate,
            fxSource: snap.rateSource,
            fxDate: snap.rateDate,
            status: 'draft' as const,
            ownerUserId: principal.userId,
            departmentId: template?.departmentId ?? principal.departmentId,
            customerPartyId: body.customerPartyId ?? null,
            version: 1,
            createdAt: now,
            updatedAt: now,
          }),
        )
        .returning();
      return toMemoDto(row!);
    });
  }

  // -------------------------------------------------------------------------------------------------- read

  async get(id: string): Promise<MemoDetailDto> {
    const { scope, principal } = this.caller.current();
    // A memo of another entity, of another party, or outside the caller's scope is invisible, not forbidden.
    const row = await this.findFor(principal, scope, id);
    if (row === undefined) throw memoNotFound();
    this.assertVisible('memo.read', row);
    const attachments: DocumentVersionDto[] = await this.documents.listForOwner(
      scope,
      MEMO_OWNER_TYPE,
      id,
    );
    return {
      ...toMemoDto(row),
      canUpdate:
        EDITABLE.includes(row.status) && can(principal, 'memo.update', memoRef(row)).allowed,
      attachments,
      approval: await this.latestApproval(scope, id),
    };
  }

  // --------------------------------------------------------------------------------------------------- list

  /**
   * The memos the caller may open, newest first. The visibility filter is AuthzService.scopeWhere, the SQL twin
   * of the record check `get` runs, so a row appears here exactly when its id would open: own memos for Sales,
   * the department's for a department lead, the entity's for `all`, never another tenant's or entity's. Keyset
   * pagination on (created_at, id): the order is total, so a page edge neither skips nor repeats a memo, and
   * a page costs the same however deep it is.
   */
  async list(query: MemoListQuery): Promise<MemoList> {
    this.authz.assert('memo.read');
    const cursor = query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    // The cursor carries the timestamp as Postgres printed it (microseconds), not as a JS Date (milliseconds).
    const createdKey = sql<string>`to_char(${testMemos.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const { principal } = this.caller.current();
    const filters: SQL[] = [
      live(),
      this.authz.scopeWhere(testMemos, 'memo.read'),
      or(
        notInArray(testMemos.status, ['draft', 'returned']),
        eq(testMemos.ownerUserId, principal.userId),
      )!,
    ];
    if (query.status !== undefined) filters.push(eq(testMemos.status, query.status));
    if (cursor !== undefined) {
      filters.push(
        sql`(${testMemos.createdAt}, ${testMemos.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await this.db
      .select({
        memo: testMemos,
        createdKey,
        ownerName: users.displayName,
        departmentName: departments.name,
      })
      .from(testMemos)
      .leftJoin(
        users,
        and(eq(users.tenantId, testMemos.tenantId), eq(users.id, testMemos.ownerUserId)),
      )
      .leftJoin(
        departments,
        and(
          eq(departments.tenantId, testMemos.tenantId),
          eq(departments.id, testMemos.departmentId),
        ),
      )
      .where(and(...filters))
      .orderBy(desc(testMemos.createdAt), desc(testMemos.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(({ memo, ownerName, departmentName }) => ({
        id: memo.id,
        number: memo.number,
        title: memo.title,
        status: memo.status,
        amount: memo.amount,
        currency: memo.currency as MemoDto['currency'],
        ownerUserId: memo.ownerUserId,
        ownerName: ownerName?.trim() ? ownerName : null,
        departmentName: departmentName ?? null,
        createdAt: iso(memo.createdAt),
        updatedAt: iso(memo.updatedAt),
      })),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeCursor({ createdAt: last.createdKey, id: last.memo.id })
          : null,
    };
  }

  // ------------------------------------------------------------------------------------------------ update

  async update(id: string, body: UpdateMemoBody): Promise<MemoDto> {
    const { scope, actor, principal } = this.caller.current();
    const template = body.template ? await this.templateSnapshot(body.template) : undefined;
    const now = this.clock();
    return withTx(this.db, scope, actor, async (tx) => {
      const row = await this.lock(tx, scope, id);
      // Scope first (404), then state (409): someone who may not edit learns nothing about the status.
      this.assertVisible('memo.update', row);
      this.assertEditable(row);
      this.assertVersion(row, body.expectedVersion);

      const money: Money = {
        amount: body.amount ?? row.amount,
        currency: (body.currency ?? row.currency) as Money['currency'],
      };
      // Re-freeze the NPR value only when the money changed: a title edit must not move the rate date.
      const moneyChanged = body.amount !== undefined || body.currency !== undefined;
      const snap = moneyChanged ? await this.money.toNprSnapshot(tx, scope, money, now) : undefined;

      const [updated] = await tx
        .update(testMemos)
        .set({
          ...(template !== undefined && { template, departmentId: template.departmentId }),
          ...(body.title !== undefined && { title: body.title }),
          ...(body.body !== undefined && { body: body.body }),
          ...(snap !== undefined && {
            amount: money.amount,
            currency: money.currency,
            amountNpr: snap.amountNpr,
            fxRate: snap.rate,
            fxSource: snap.rateSource,
            fxDate: snap.rateDate,
          }),
          editorUserIds: [...new Set([...row.editorUserIds, principal.userId])],
          version: row.version + 1,
          updatedAt: now,
        })
        .where(scoped(scope).where(testMemos, eq(testMemos.id, id)))
        .returning();
      return toMemoDto(updated!);
    });
  }

  private assertVersion(row: MemoRow, expected: number | undefined): void {
    if (expected !== undefined && row.version !== expected) {
      throw new ConflictException({
        code: 'conflict',
        message: 'The memo has changed since you opened it',
        reason: 'stale_memo',
      });
    }
  }

  // ----------------------------------------------------------------------------------------------- discard

  /**
   * Soft-discards the caller's own unsubmitted memo (draft or returned). Order of refusals, so nobody learns more
   * than they could already read: out of scope or someone else's private draft is 404; a memo the caller can read
   * but did not create is 403; a submitted, approved or rejected memo is 409. The row is locked first, so a
   * concurrent autosave or submit waits and then finds the memo gone (404) instead of writing to it. A second
   * discard of the same memo is also 404. The audit trigger records the update with the actor.
   */
  async discard(id: string): Promise<void> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    await withTx(this.db, scope, actor, async (tx) => {
      const row = await this.lock(tx, scope, id);
      this.assertVisible('memo.update', row);
      if (row.ownerUserId !== principal.userId) {
        throw new ForbiddenException({
          code: 'forbidden',
          message: 'Only the person who created a memo can discard it',
          reason: 'not_creator',
        });
      }
      this.assertEditable(row);
      await tx
        .update(testMemos)
        .set({
          discardedAt: now,
          discardedByUserId: principal.userId,
          version: row.version + 1,
          updatedAt: now,
        })
        .where(scoped(scope).where(testMemos, eq(testMemos.id, id)));
    });
  }

  // ------------------------------------------------------------------------------------------------ submit

  async submit(id: string, expectedVersion?: number): Promise<SubmitMemoResult> {
    const { scope, actor, principal } = this.caller.current();
    const now = this.clock();
    const result = await withTx(this.db, scope, actor, async (tx) => {
      const row = await this.lock(tx, scope, id);
      this.assertVisible('memo.update', row);
      this.assertEditable(row);
      this.assertVersion(row, expectedVersion);
      // allClean reads committed document rows: a scan that finishes after this point only makes a file
      // clean sooner, and an upload that starts after it belongs to the next submit.
      if (!(await this.documents.allClean(scope, MEMO_OWNER_TYPE, id))) throw notAllClean();
      // A second read for the snapshot: an upload that committed between the two reads must not be frozen
      // unscanned, so the same rule is applied again to exactly the versions that get frozen.
      const versions = await this.documents.listForOwner(scope, MEMO_OWNER_TYPE, id);
      const attachments = frozenAttachments(versions);
      if (attachments === undefined) throw notAllClean();

      const base = {
        documentType: MEMO_OWNER_TYPE,
        documentId: row.id,
        documentNumber: row.number,
        title: row.title,
        requesterUserId: row.ownerUserId,
        sodUserIds: this.sodUserIds(row, principal.userId, versions),
        // The actor of the submit action; the engine records it apart from the requester.
        submittedByUserId: principal.userId,
      } satisfies Partial<SubmitInput>;

      if (row.template) {
        // Internal correspondence: no money, no thresholds. The route is the people the author named.
        const directory = await this.directory();
        const selected = [...row.template.recommenders, row.template.approvedBy];
        if (selected.some((p) => !directory.people.some((active) => active.userId === p.userId))) {
          throw new ConflictException('A selected approver is no longer active in this company');
        }
        // A signer who cannot decide approvals could never act on the step: refuse by name rather than
        // strand the memo (and no role grant is widened to make it work).
        const lacking = selected.find(
          (p) => directory.people.find((d) => d.userId === p.userId)?.canApprove !== true,
        );
        if (lacking) {
          throw new ConflictException(
            `${lacking.name} cannot decide approvals; choose someone with approval rights.`,
          );
        }
        const submitted = await this.approvals.submit(tx, {
          ...base,
          // Plain strings only: the engine hashes this snapshot, so it must not hold Dates or row internals.
          // No amount, currency or FX fields: a template memo has no money to freeze or to show approvers.
          snapshot: {
            template: row.template,
            number: row.number,
            title: row.title,
            body: row.body,
            ownerUserId: row.ownerUserId,
            customerPartyId: row.customerPartyId,
            memoVersion: row.version,
            attachments,
          },
          facts: {},
          explicitSteps: explicitRouteOf(row.template),
        });
        await tx
          .update(testMemos)
          .set({ status: 'submitted', version: row.version + 1, updatedAt: now })
          .where(scoped(scope).where(testMemos, eq(testMemos.id, id)));
        return submitted;
      }

      // Legacy P1 memo: route on the rate of the submit day, not the draft day: a draft kept for a week must
      // not dodge the management step because the rate moved. Inside the lock, so the stored value is the one
      // routed on.
      const snap = await this.money.toNprSnapshot(
        tx,
        scope,
        { amount: row.amount, currency: row.currency as Money['currency'] },
        now,
      );
      const submitted = await this.approvals.submit(tx, {
        ...base,
        snapshot: {
          template: null,
          number: row.number,
          title: row.title,
          body: row.body,
          amount: row.amount,
          currency: row.currency,
          amountNpr: snap.amountNpr,
          fxRate: snap.rate,
          fxSource: snap.rateSource,
          fxDate: snap.rateDate,
          ownerUserId: row.ownerUserId,
          customerPartyId: row.customerPartyId,
          memoVersion: row.version,
          attachments,
        },
        // The router compares this decimal string with decimal.js (never a float).
        facts: { amountNpr: snap.amountNpr },
      });
      await tx
        .update(testMemos)
        .set({
          status: 'submitted',
          amountNpr: snap.amountNpr,
          fxRate: snap.rate,
          fxSource: snap.rateSource,
          fxDate: snap.rateDate,
          version: row.version + 1,
          updatedAt: now,
        })
        .where(scoped(scope).where(testMemos, eq(testMemos.id, id)));
      return submitted;
    });
    // After COMMIT, never inside: the drainer runs on its own connection and would find no outbox row yet.
    await this.notify?.nudge();
    return result;
  }

  // ------------------------------------------------------------------------------------------ route preview

  /**
   * The route submit would build now, without writing anything (the memo page's "Approval route" panel). Built
   * from the same people and the same separation-of-duties list as submit, so the two agree: for a template memo
   * the selected signers in order, for a legacy memo the workflow's role steps on the stored NPR value. Needs the
   * same permission as submit. A requester who may not approve sees the steps but not the eligible people.
   */
  async routePreview(id: string): Promise<RoutePlan> {
    const { scope, principal } = this.caller.current();
    const row = await this.find(this.db, scope, id);
    if (row === undefined) throw memoNotFound();
    this.assertVisible('memo.update', row);
    const versions = await this.documents.listForOwner(scope, MEMO_OWNER_TYPE, id);
    const sod = this.sodUserIds(row, principal.userId, versions);
    if (row.template) {
      const plan = await this.approvals.preview(
        scope,
        MEMO_OWNER_TYPE,
        {},
        sod,
        explicitRouteOf(row.template),
      );
      return this.explainTemplatePlan(scope, row.template, plan);
    }
    return this.approvals.preview(scope, MEMO_OWNER_TYPE, { amountNpr: row.amountNpr }, sod);
  }

  /**
   * The engine's plan for a template memo, plus the one thing it cannot know: whether each signer holds the
   * approval permission. A signer without it is shown as a blocked step (submit would refuse the same memo), and the
   * block reason names the person instead of an id.
   */
  private async explainTemplatePlan(
    scope: TxScope,
    template: MemoTemplateSnapshot,
    plan: RoutePlan,
  ): Promise<RoutePlan> {
    const people = [...template.recommenders, template.approvedBy];
    const approvers = await this.approverIds(
      scope,
      people.map((p) => p.userId),
    );
    const steps = plan.steps.map((s, i) => {
      const person = people[i];
      return person !== undefined && !approvers.has(person.userId)
        ? { ...s, blocked: true, eligibleUserIds: [] }
        : s;
    });
    const first = steps.findIndex((s) => s.blocked);
    const who = first === -1 ? undefined : people[first];
    if (who === undefined) return { ...plan, steps };
    return {
      steps,
      blocked: true,
      blockReason: !approvers.has(who.userId)
        ? `${who.name} cannot decide approvals; choose someone with approval rights.`
        : `${who.name} prepared or edited this memo, or is no longer active, so cannot approve it; choose someone else.`,
    };
  }

  /**
   * Whoever shaped what the approvers see: the owner, every editor, everyone who uploaded a version (even a
   * rejected one), and the person pressing submit (a founder may submit a colleague's memo).
   */
  private sodUserIds(
    row: MemoRow,
    actingUserId: string,
    versions: readonly DocumentVersionDto[],
  ): string[] {
    return [
      ...new Set([
        row.ownerUserId,
        ...row.editorUserIds,
        actingUserId,
        ...versions.flatMap((v) => (v.uploadedBy === null ? [] : [v.uploadedBy])),
      ]),
    ];
  }

  // -------------------------------------------------------------------------------------------- onDecided

  /**
   * Called by ApprovalsService.act in the deciding transaction, so the memo's new status commits or rolls
   * back together with the approval. Scope comes from the transaction's bos.* settings: `act` is an API call,
   * but the subject must not depend on a request.
   */
  private async onDecided(
    tx: DbTransaction,
    documentId: string,
    outcome: 'approved' | 'returned' | 'rejected',
  ): Promise<void> {
    const { scope } = await readTxContext(tx);
    const updated = await tx
      .update(testMemos)
      .set({ status: outcome, version: sql`${testMemos.version} + 1`, updatedAt: this.clock() })
      .where(
        scoped(scope).where(
          testMemos,
          and(eq(testMemos.id, documentId), eq(testMemos.status, 'submitted')),
        ),
      )
      .returning({ id: testMemos.id });
    if (updated.length === 0) {
      // Throwing rolls the decision back. A decided request whose memo is not "submitted" means the two
      // tables disagree, and a silent skip would leave the memo's status wrong forever.
      this.log.error(`memo ${documentId} is not submitted; refusing to record outcome ${outcome}`);
      throw new ConflictException({
        code: 'conflict',
        message: 'The memo is not waiting for a decision',
      });
    }
  }

  // ----------------------------------------------------------------------------------------------- helpers

  /**
   * Record-level authz that answers 404, not 403, for a memo outside the caller's scope: a 403 would confirm
   * that a guessed id exists. Other denials (no grant at all, inactive user) say nothing about the record, so
   * they stay 403.
   */
  private currentContentVisible(row: MemoRow): boolean {
    // editorUserIds is separation-of-duties history, never a collaboration ACL.
    // No explicit private-draft collaboration/admin capability exists in this kernel.
    return (
      !EDITABLE.includes(row.status) || row.ownerUserId === this.caller.current().principal.userId
    );
  }

  private assertVisible(action: Permission, row: MemoRow): void {
    if (!this.currentContentVisible(row)) throw memoNotFound();
    try {
      this.authz.assert(action, memoRef(row));
    } catch (error) {
      const reason =
        error instanceof ForbiddenException
          ? (error.getResponse() as { reason?: unknown }).reason
          : undefined;
      if (reason === 'out_of_scope') throw memoNotFound();
      throw error;
    }
  }

  private assertEditable(row: MemoRow): void {
    if (!EDITABLE.includes(row.status)) {
      throw new ConflictException({
        code: 'conflict',
        message: `A memo in status ${row.status} cannot be changed or submitted`,
      });
    }
  }

  private async find(q: Q, scope: TxScope, id: string): Promise<MemoRow | undefined> {
    const [row] = await q
      .select()
      .from(testMemos)
      .where(scoped(scope).where(testMemos, and(eq(testMemos.id, id), live())));
    return row;
  }

  /**
   * The memo as `principal` may look it up. Staff read by entity, and authz then narrows by scope. A customer
   * portal user reads only the memos of the acting entity that name their own party (ADR 0027 §5), so another
   * party's memo is not found at all. Memos have no vendor column, so a vendor finds none.
   */
  private async findFor(
    principal: Principal,
    scope: TxScope,
    id: string,
  ): Promise<MemoRow | undefined> {
    if (principal.orgKind === 'staff') return this.find(this.db, scope, id);
    if (principal.orgKind !== 'customer' || principal.partyId === null) return undefined;
    const [row] = await this.db
      .select()
      .from(testMemos)
      .where(
        scoped(scope).forCounterparty(
          testMemos,
          'customer',
          principal.partyId,
          and(eq(testMemos.id, id), live()),
        ),
      );
    return row;
  }

  /** The memo row, locked until the transaction ends. */
  private async lock(tx: DbTransaction, scope: TxScope, id: string): Promise<MemoRow> {
    const [row] = await tx
      .select()
      .from(testMemos)
      .where(scoped(scope).where(testMemos, and(eq(testMemos.id, id), live())))
      .for('update');
    if (row === undefined) throw memoNotFound();
    return row;
  }

  private async latestApproval(scope: TxScope, id: string): Promise<MemoApprovalSummary | null> {
    const [row] = await this.db
      .select({ requestId: approvalRequests.id, status: approvalRequests.status })
      .from(approvalRequests)
      .where(
        scoped(scope).where(
          approvalRequests,
          and(
            eq(approvalRequests.documentType, MEMO_OWNER_TYPE),
            eq(approvalRequests.documentId, id),
          ),
        ),
      )
      // The open request first (at most one per memo: partial unique index), then the newest. Ordering by
      // submitted_at alone could return an old returned request when two submits share a timestamp.
      .orderBy(sql`${approvalRequests.decidedAt} IS NULL DESC`, desc(approvalRequests.submittedAt))
      .limit(1);
    return row ?? null;
  }
}
