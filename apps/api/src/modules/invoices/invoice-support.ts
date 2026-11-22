// Small shared pieces of the invoice services (P3 unit U10): who is calling, the coded errors, the Kathmandu day and
// the postgres error reader. Kept apart so the issue service (U6 extends it) and the drafting service share one copy.
import { type CountryCode, formatAddressLines, type PrintAddress } from '@bos/contracts';
import { kathmanduDate } from '@bos/locale';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { principal, type Principal } from '../../platform/authz/principal';
import { requestTx, type Actor, type TxScope } from '../../platform/db/tx';

/** Injection token for a test clock; production falls back to the system time. */
export const INVOICE_CLOCK = Symbol('INVOICE_CLOCK');

export interface InvoiceCallerInfo {
  scope: TxScope;
  actor: Actor;
  principal: Principal;
}

/** Who is calling, read from the request store. A class so tests can switch the caller without an HTTP request. */
@Injectable()
export class InvoiceCaller {
  current(): InvoiceCallerInfo {
    const { scope, actor } = requestTx();
    return { scope, actor, principal: principal() };
  }
}

export const invoiceNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Invoice not found' });
export const scheduleLineNotFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Schedule line not found' });
export const forbidden = () =>
  new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: 'no_permission' });
export const badRequest = (message: string) =>
  new BadRequestException({ code: 'bad_request', message });
export const conflict = (message: string) => new ConflictException({ code: 'conflict', message });

/** 409 SCHEDULE_LINE_TAKEN: the schedule line already has a live invoice (done check 6). */
export const scheduleLineTaken = () =>
  new ConflictException({
    code: 'SCHEDULE_LINE_TAKEN',
    message: 'This billing schedule line already has an invoice',
  });

/** 409 NOT_APPROVED: a tax invoice, credit note or debit note issues only after approval (U6). */
export const notApproved = () =>
  new ConflictException({
    code: 'NOT_APPROVED',
    message: 'This invoice is issued only after it has been approved',
  });

/**
 * 403 `separation_of_duties` (TR-Q12f): whoever created a credit or debit note may not issue it, as the creator of a
 * vendor may not activate it. Invoices are not covered: Kuu's answer names the notes only.
 */
export const noteIssuerIsCreator = () =>
  new ForbiddenException({
    code: 'forbidden',
    message: 'The creator of a credit or debit note cannot issue it',
    reason: 'separation_of_duties',
  });

/** Whether `userId` created this note, so may not issue it (TR-Q12f). A note with no recorded creator blocks nobody. */
export const createdThisNote = (
  invoice: { kind: string; createdBy: string | null },
  userId: string | null,
): boolean =>
  (invoice.kind === 'credit_note' || invoice.kind === 'debit_note') &&
  userId !== null &&
  invoice.createdBy === userId;

/**
 * 422 DUE_DATE_BEFORE_ISSUE: the drafted due date is before today, the issue date, so the invoice would be overdue the
 * moment it is issued. Its own code, so the workspace never words it as a stale version (409 conflict). `details`
 * carries the two dates when they are known (the database check names neither).
 */
export const dueDateBeforeIssue = (dates?: { dueDate: string; issueDate: string }) =>
  new UnprocessableEntityException({
    code: 'DUE_DATE_BEFORE_ISSUE',
    message: 'The due date is before the issue date; correct the due date and issue again',
    ...(dates === undefined ? {} : { details: dates }),
  });

/** The `YYYY-MM-DD` of the Kathmandu calendar day of `at` (plan A10: the issue date is server today). */
export function kathmanduDay(at: Date): string {
  const { y, m, d } = kathmanduDate(at);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** The pg error behind `error` (drizzle may wrap it as `cause`): its SQLSTATE and, when named, the constraint. */
export function pgError(error: unknown): { code: string; constraint?: string } | undefined {
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

/**
 * An address on one line, as the invoice snapshots hold it: `line, city[, Country name]`. The country is left out
 * when it is `ownCountry` (the issuing entity's own), exactly as the PDF prints it.
 */
export function formatAddress(a: PrintAddress, ownCountry?: CountryCode): string {
  return formatAddressLines(a, a.country, ownCountry).join(', ');
}

/** Staff only: the workspace invoice routes carry internal figures; a portal caller reads through the portal API. */
export function assertStaff(p: Principal): void {
  if (p.orgKind !== 'staff') throw forbidden();
}
