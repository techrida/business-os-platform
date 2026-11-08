// What documents needs from other units, written as small interfaces plus injection tokens.
// Serves NFR Maintainability: this module is built and tested while authz (U1), audit (U2) and
// notify (U5) are still being written. The module file wires each token to the real service with
// `useExisting`, so this file is the only place that states what documents really calls.
import type { Permission } from '@bos/contracts';
import type { DbTransaction, TxScope } from '../db/tx';
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
 * An owner record type (for example a test memo) tells documents who may touch its attachments.
 * Registered by the module that owns the record; U8 registers 'test_memo'.
 */
export interface DocumentOwnerPolicy {
  ownerType: string;
  /** The record's ResourceRef for authz, or null when the owner does not exist or is invisible. */
  resource(scope: TxScope, ownerId: string): Promise<ResourceRef | null>;
  /**
   * Whether the owner still takes attachments (for a memo: only while it is a draft). Asked inside the
   * upload, new-version and remove transactions, before anything is written; false answers 409. `tx` is that
   * transaction, so an owner can lock its own row (FOR SHARE) and close the race with its submit. Absent
   * means "always" (the behaviour before this existed). Removal asks it too: a file on a submitted memo is
   * part of what was approved and cannot be taken away.
   */
  canAttach?(scope: TxScope, ownerId: string, tx?: DbTransaction): Promise<boolean>;
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
