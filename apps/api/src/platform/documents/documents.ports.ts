// What documents needs from other units, written as small interfaces plus injection tokens.
// Serves NFR Maintainability: this module is built and tested while authz (U1), audit (U2) and
// notify (U5) are still being written. The module file wires each token to the real service with
// `useExisting`, so this file is the only place that states what documents really calls.
import type { Permission } from '@bos/contracts';
import type { Actor, DbTransaction, TxScope } from '../db/tx';
import type { ResourceRef } from '../authz/can';

/** The BullMQ queue and job name for the virus scan. */
export const DOCS_SCAN_QUEUE = 'docs.scan';
export const DOCS_SCAN_JOB = 'docs.scan';

/** Job payload. The worker has no request, so the scope travels with the job. */
export interface ScanJobData {
  versionId: string;
  tenantId: string;
  organizationId: string;
}

/**
 * The portal org kinds whose callers an owner policy may let upload (`allowsCounterparty`): customers (P3 U5) and
 * vendors (P4 PV2). Each policy checks `kind` itself; one that only serves customers refuses a vendor.
 */
export const COUNTERPARTY_KINDS = ['customer', 'vendor'] as const;
export type CounterpartyKind = (typeof COUNTERPARTY_KINDS)[number];

/**
 * A portal caller as an owner policy sees it: plain data, no authz internals. Only an active caller with a
 * party, acting in the transaction's tenant and entity as itself, is ever handed to a policy.
 */
export interface CounterpartyPrincipal {
  kind: CounterpartyKind;
  /** `app.users.id` of the portal user. */
  userId: string;
  /** The customer or vendor party the caller acts for (`idp_orgs.party_id`), never empty. */
  partyId: string;
  /** The tenant and acting entity of the request, so the policy can scope its lookup. */
  tenantId: string;
  organizationId: string;
}

/** One way to authorise a staff upload to an owner record: `action` allowed on `ref` (see `uploadGrants`). */
export interface UploadGrant {
  action: Permission;
  ref: ResourceRef;
}

/**
 * An owner record type (for example a test memo) tells documents who may touch its attachments.
 * Registered by the module that owns the record; U8 registers 'test_memo'.
 */
export interface DocumentOwnerPolicy {
  ownerType: string;
  /**
   * The permission that authorises a staff upload to this owner (create, receive, new version, remove), checked
   * against the same owner ref. Absent means `documents.upload`. Reads, the system path, the counterparty hook,
   * the type, size and scan rules are unchanged. P3: payment proof uses `payment.record`. A list means any one of
   * them, each checked on the owner ref (P4 bank evidence: whoever proposes or verifies the account).
   */
  uploadPermission?: Permission | readonly Permission[];
  /**
   * Owning-module actions a caller may name for a staff upload (U20a2-Q3). The owning module's own route passes the
   * action (`UploadAction`) to create, createVersion and receiveContent; it is never read from a request body. When
   * the action is listed here it is checked on the uploader's own file: a new file belongs to whoever uploads it,
   * a new version to the document's creator, the bytes to the version's uploader. So an `own` grant of that action
   * covers the caller's own files, exactly as it covers the records they enter. Passing it is enough; otherwise the
   * usual check (`uploadPermission` on the owner ref) still runs, so nobody loses access. An action not listed here,
   * or none, means the usual check alone (deny by default). The owner must still exist (404) and `canAttach`, the
   * type, size and scan rules still apply. P4: `payables.bill.enter` for staff invoice files.
   */
  uploadActions?: readonly Permission[];
  /**
   * The upload grants of one owner record, for an owner type that spans several kinds of record whose permissions
   * differ (round 5 P2: `evidence` belongs to a sales order, a vendor bill or an RFQ). When present it replaces
   * `uploadPermission` for every staff upload check of this owner (create, receive, new version, remove): the caller
   * passes when any one returned `action` is allowed on its `ref`, so a sales-order grant never reaches a bill. An
   * empty list refuses (403); null means the owner does not exist in this scope (404). `uploadActions`, the
   * counterparty hook, reads and the system path are unchanged. Absent means `uploadPermission` as before.
   */
  uploadGrants?(scope: TxScope, ownerId: string): Promise<readonly UploadGrant[] | null>;
  /**
   * True when this owner's files change only on the owning module's own routes, by their uploader (round 5 P2:
   * `evidence`). The generic new-version and remove routes then answer 409, after the permission check, and a
   * version's bytes are taken only from the user who reserved it (403 otherwise), on any route. The owning module
   * removes through `removeInTransaction` after its own uploader check. Absent means the generic routes as before.
   */
  ownRoutesOnly?: boolean;
  /**
   * A permission that also authorises a staff read of this owner's files (get, download link), checked on the
   * owner ref. It is in addition to `documents.read`, never instead: a caller passes with either. Lets the owning
   * module's own read grant open its records' files without widening `documents.read` (P4: `vendor.read` for a
   * vendor's bank evidence and submitted files; K3: `verification.review` for case files). Absent means
   * `documents.read` alone, as before.
   */
  readPermission?: Permission;
  /**
   * The declared types this owner takes (U12: PNG, JPEG and WebP for logos and avatars). It only narrows the generic
   * allow-list (ALLOWED_MIME): a type outside either is a 415 before any row is written. Absent means the generic list.
   * Applies to every staff and system create and new version of this owner; the type check and the scan still run.
   */
  allowedMime?: readonly string[];
  /**
   * The largest declared size this owner takes, in bytes (U12: IMAGE_MAX_BYTES). It only narrows MAX_UPLOAD_BYTES:
   * anything larger is a 413 before any row is written. Absent means the generic limit.
   */
  maxBytes?: number;
  /** The record's ResourceRef for authz, or null when the owner does not exist or is invisible. */
  resource(scope: TxScope, ownerId: string): Promise<ResourceRef | null>;
  /**
   * Whether the owner still takes attachments (for a memo: only while it is a draft). Asked inside the
   * upload, new-version and remove transactions, before anything is written; false answers 409. `tx` is that
   * transaction, so an owner can lock its own row (FOR SHARE) and close the race with its submit. Absent
   * means "always" (the behaviour before this existed). Removal asks it too: a file on a submitted memo is
   * part of what was approved and cannot be taken away.
   * `documentId` is supplied for receive, new-version and remove; it is absent when creating a new
   * document. Intake owners shared by many records can therefore freeze only that document's references.
   */
  canAttach?(
    scope: TxScope,
    ownerId: string,
    tx?: DbTransaction,
    documentId?: string,
  ): Promise<boolean>;
  /**
   * Whether the system actor (`system:<job>`, a background job with no user) may add generated files to this
   * owner, for example a quotation PDF. `createGenerated` and the receive step of a generated file ask it
   * instead of the request principal's authz check, and a refusal means no row and no bytes. Absent means
   * no: an owner that does not implement it never takes generated files (deny by default). It replaces
   * `canAttach` for the system path: `canAttach` models a user adding to a draft, this models a job.
   */
  allowsSystemActor?(
    scope: TxScope,
    ownerId: string,
    actor: Pick<Actor, 'kind' | 'id'>,
    tx?: DbTransaction,
  ): Promise<boolean>;
  /**
   * Whether this portal caller may upload to this owner without the `documents.upload` grant, for example a
   * customer attaching payment proof to their own submitted payment. Asked by `create` and the receive step
   * only, inside their transaction, and only for a counterparty principal; staff never reach it. True skips
   * the grant check and nothing else: the owner must exist (404), `canAttach` still applies (409), and the
   * type, size and scan rules are unchanged. Absent or false means the usual grant check, which refuses a
   * portal caller with the usual 403 (deny by default). The policy must check that the record names
   * `principal.partyId` itself: documents does not.
   */
  allowsCounterparty?(
    principal: CounterpartyPrincipal,
    ownerId: string,
    tx: DbTransaction,
  ): Promise<boolean>;
}

export const AUTHZ_PORT = Symbol('DOCUMENTS_AUTHZ_PORT');
/** `AuthzService.assert` (U1): throws ForbiddenException {code:'forbidden', reason}. */
export interface AuthzPort {
  assert(action: Permission, resource?: ResourceRef): void;
}

export const AUDIT_PORT = Symbol('DOCUMENTS_AUDIT_PORT');
/** `AuditService.record` (U2): a domain event written in the caller's transaction. */
export interface AuditPort {
  record(
    tx: DbTransaction,
    event: {
      action: string;
      entityType: string;
      entityId: string;
      before?: unknown;
      after?: unknown;
      meta?: Record<string, unknown>;
    },
  ): Promise<void>;
}

export const NOTIFY_PORT = Symbol('DOCUMENTS_NOTIFY_PORT');
/** `NotifyService.notifyUser` (U5), reduced to the call documents makes. */
export interface NotifyPort {
  notifyUser(
    tx: DbTransaction,
    n: {
      userId: string;
      title: string;
      body: string;
      link: string;
      email?: { template: 'document.infected'; vars: Record<string, string> };
      dedupeKey: string;
    },
  ): Promise<void>;
}
