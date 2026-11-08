// The seams the approval engine needs from other units, as Nest injection tokens. Serves the NFR
// "every change is audited and every approver is told": the engine calls these inside its own
// transaction, so an approval, its audit event and its notification commit or roll back together.
//
// ApprovalsAudit and ApprovalsNotify stand in for U2's AuditService and U5's NotifyService, which did
// not exist when U7 was written. Each is a structural subset of the real class, so the lead wires
//   { provide: ApprovalsAudit, useExisting: AuditService }
//   { provide: ApprovalsNotify, useExisting: NotifyService }
// and nothing else changes. Tests pass fakes.
import { Injectable } from '@nestjs/common';
import type { RoleKey } from '@bos/contracts';

import { principal, type Principal } from '../../platform/authz/principal';
import type { DbTransaction } from '../../platform/db/db.module';
import { requestTx, type Actor, type TxScope } from '../../platform/db/tx';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  meta?: Record<string, unknown>;
}

/** U2 `AuditService.record` (P1-PLAN section 6.2). */
export abstract class ApprovalsAudit {
  abstract record(tx: DbTransaction, e: AuditEntry): Promise<void>;
}

/** The approval subset of U5's EmailTemplate union. */
export type ApprovalEmailTemplate =
  | 'approval.pending'
  | 'approval.reminder'
  | 'approval.escalated'
  | 'approval.decided'
  | 'approval.blocked';

export interface UserNotice {
  userId: string;
  title: string;
  body: string;
  link: string;
  email?: { template: ApprovalEmailTemplate; vars: Record<string, string> };
  dedupeKey: string;
}

/** U5 `NotifyService.notifyUser` / `notifyRole` (P1-PLAN section 6.2). */
export abstract class ApprovalsNotify {
  abstract notifyUser(tx: DbTransaction, n: UserNotice): Promise<void>;
  abstract notifyRole(
    tx: DbTransaction,
    role: RoleKey,
    n: Omit<UserNotice, 'userId'>,
  ): Promise<void>;
}

/** Who is calling, for the HTTP methods (act, inbox, get, reroute and the admin routes). */
export interface Caller {
  scope: TxScope;
  actor: Actor;
  principal: Principal;
}

/**
 * Reads the caller from the request store. A class (not a function call inside the service) so tests
 * can switch actors without a request, and so the worker never touches it: the SLA tick runs with
 * systemActor and never asks for a caller.
 */
@Injectable()
export class ApprovalsCaller {
  current(): Caller {
    const { scope, actor } = requestTx();
    return { scope, actor, principal: principal() };
  }
}

/** Injection token for the clock; tests pass a fake one to move time for the SLA. */
export const APPROVALS_CLOCK = Symbol('APPROVALS_CLOCK');
export type Clock = () => Date;
