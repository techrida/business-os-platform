import {
  AccessWarningSchema,
  ErrorBodySchema,
  ErrorReasonSchema,
  type AccessWarning,
  type ErrorBody,
  type ErrorReason,
} from '@bos/contracts';
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { z } from 'zod';

import { ScanQueueDeferredError } from '../documents/scan-queue-deferred.error';
import { STEP_UP_REQUIRED } from '../auth/step-up';
import { DB_BUSY_RETRY_AFTER_SECONDS, type DbBusyKind, dbBusyKindOf } from '../db/busy';
import { newCorrelationId } from '../obs/correlation';
import { REQUEST_ID_HEADER, type CorrelatedRequest } from './correlation.middleware';
import { currentCorrelationId } from './request-context';

/** Machine-readable codes clients can switch on. The message is for humans and may change. */
export type ErrorCode =
  | 'unauthenticated'
  | 'step_up_required'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'stale_access'
  | 'members_changed'
  | 'fx_rate_stale'
  | 'duplicate_pan_vat'
  | 'duplicate_found'
  | 'primary_contact_exists'
  | 'contact_email_required'
  | 'quotation_not_sent'
  | 'quotation_expired'
  | 'quotation_closed'
  | 'quotation_pdf_not_ready'
  // The staff PDF downloads and their Retry (PDF_STATE_CODES): each code has one status.
  | 'quotation_pdf_failed'
  | 'quotation_pdf_unavailable'
  | 'quotation_pdf_retry_not_needed'
  | 'invoice_pdf_not_ready'
  | 'invoice_pdf_failed'
  | 'invoice_pdf_unavailable'
  | 'invoice_pdf_scan_refused'
  | 'invoice_pdf_retry_not_needed'
  | 'purchase_order_pdf_not_ready'
  | 'purchase_order_pdf_failed'
  | 'purchase_order_pdf_unavailable'
  | 'purchase_order_pdf_scan_refused'
  | 'purchase_order_pdf_retry_not_needed'
  | 'kyb_not_verified'
  | 'customer_merged'
  | 'idp_org_taken'
  | 'first_admin_owner_only'
  | 'account_owner_missing'
  | 'invalid_transition'
  | 'kyb_not_submitted'
  | 'kyc_expired'
  | 'vendor_not_editable'
  | 'vendor_identity_locked'
  | 'customer_identity_locked'
  | 'account_exists'
  | 'no_verified_bank_account'
  | 'callback_evidence_not_clean'
  // TR-Q12e: a record refuses a file the virus scan found infected (any attach point, one code).
  | 'document_infected'
  | 'NO_ELIGIBLE_APPROVER'
  | 'APPROVER_NOT_ELIGIBLE'
  | 'evidence_policy_unmet'
  | 'decided_on_in_future'
  // P3 sales orders, payments and invoices.
  | 'quotation_not_accepted'
  | 'evidence_not_filed'
  | 'draft_of_other_revision'
  | 'credit_hold'
  | 'sales_order_not_open'
  | 'delivery_already_released'
  | 'contact_activity_required'
  | 'schedule_line_not_planned'
  | 'SCHEDULE_LINE_TAKEN'
  | 'NOT_APPROVED'
  | 'DUE_DATE_BEFORE_ISSUE'
  | 'CREDIT_EXCEEDS_INVOICE'
  | 'OVER_ALLOCATION'
  | 'MISMATCHED_ITEMS'
  | 'payment_not_submitted'
  | 'payment_not_verified'
  | 'proof_not_clean'
  // F1-Q33 promises to pay.
  | 'invoice_not_open'
  | 'promise_open'
  | 'invalid_proof'
  | 'unknown_customer'
  | 'unknown_withholding_code'
  | 'reason_required'
  | 'invalid_evidence_document'
  | 'invalid_payment_schedule'
  | 'evidence_required'
  | 'over_receipt'
  | 'over_receipt_exception_unknown'
  | 'po_line_unknown'
  | 'duplicate_po_line'
  | 'receipt_kind_mismatch'
  | 'serials_required'
  | 'serials_not_allowed'
  | 'serial_duplicate'
  | 'RECEIPT_DATE_IN_FUTURE'
  | 'BILL_DATE_IN_FUTURE'
  | 'VENDOR_NOT_APPROVED'
  | 'VENDOR_NOT_IN_ENTITY'
  | 'FEWER_THAN_MIN_QUOTES'
  | 'rfq_deadline_passed'
  | 'PO_HAS_RECEIPTS'
  | 'PO_HAS_BILLS'
  | 'PO_HAS_NO_LINES'
  | 'PO_VENDOR_CHANGE_NOT_DRAFT'
  | 'PO_VENDOR_UNCHANGED'
  | 'PO_REFERENCED'
  | 'PO_VENDOR_CHANGE_NO_RFQ'
  | 'PO_VENDOR_NO_QUOTATION'
  | 'PO_VENDOR_CHANGE_PENDING'
  | 'VENDOR_CURRENCY_NOT_SUPPORTED'
  | 'VENDOR_NOT_VAT_REGISTERED'
  | 'PO_CHANGED'
  | 'VENDOR_NO_VERIFIED_BANK_ACCOUNT'
  | 'PO_AMENDMENT_INVALID'
  | 'DUPLICATE_BILL'
  | 'BILL_NOT_MATCHED'
  | 'BILL_DOCUMENT_NOT_CLEAN'
  | 'PO_NOT_BILLABLE'
  | 'MATCH_NOT_REQUIRED'
  | 'BILL_NOT_POSTED'
  | 'BILL_HAS_ALLOCATIONS'
  | 'BILL_KIND_NOT_SUPPORTED'
  | 'CURRENCY_NOT_SUPPORTED'
  | 'CURRENCY_NOT_ENABLED'
  | 'BILL_HAS_PAYMENT_REQUEST'
  | 'SUBMISSION_NOT_RECEIVED'
  | 'SUBMISSION_FILE_NOT_CLEAN'
  | 'SUBMISSION_HAS_NO_VENDOR'
  | 'SUBMISSION_INCOMPLETE'
  | 'SUBMISSION_MISMATCH'
  | 'DOCUMENT_NOT_FOUND'
  | 'PO_REQUIRED'
  | 'PO_LINE_REQUIRED'
  | 'PO_LINE_NOT_FOUND'
  | 'RECEIPT_LINE_NOT_FOUND'
  | 'PO_VENDOR_MISMATCH'
  | 'TAX_CODE_NOT_FOUND'
  | 'WITHHOLDING_CODE_NOT_FOUND'
  | 'ADVANCE_NOT_SUPPORTED'
  | 'DUPLICATE_OPEN_ITEM'
  | 'NOT_A_VENDOR_BILL_ITEM'
  | 'BILL_NOT_PAYABLE'
  | 'CURRENCY_MISMATCH'
  | 'PURCHASE_ORDER_NOT_FOUND'
  // Round 5 P1: the paying company bank account of a payment request.
  | 'BANK_ACCOUNT_INVALID'
  | 'BANK_ACCOUNT_CURRENCY_MISMATCH'
  // Round 5 P1: a bill line booked to an account that is not an active expense account of the entity.
  | 'EXPENSE_ACCOUNT_INVALID'
  // U20b access settings and last-Founder guard.
  | 'confirmation_required'
  | 'last_founder'
  | 'unprocessable'
  | 'supporting_document_unsupported'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'bad_request'
  | 'unavailable'
  // A deadlock victim or a lock wait over lock_timeout: rolled back, safe to retry (503 + Retry-After).
  | 'db_busy'
  | 'internal';

export function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 401:
      return 'unauthenticated';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 409:
      return 'conflict';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 503:
      return 'unavailable';
    default:
      // Any other 4xx is the caller's fault (400, 405, 422, 429 ...); anything else is ours.
      return status >= 400 && status < 500 ? 'bad_request' : 'internal';
  }
}

const GENERIC_MESSAGE: Record<ErrorCode, string> = {
  unauthenticated: 'Authentication required',
  step_up_required: 'Sign in again to continue',
  forbidden: 'Forbidden',
  not_found: 'Not found',
  conflict: 'Conflict',
  stale_access: 'Access was changed by someone else. Reload to see the latest.',
  members_changed: 'The people in this department changed. Check the list and try again.',
  fx_rate_stale: 'The exchange rate is too old',
  duplicate_pan_vat: 'Another customer already has this PAN/VAT number',
  duplicate_found: 'This looks like a record that already exists',
  primary_contact_exists: 'This customer already has a primary contact',
  contact_email_required: 'This customer needs a contact with an email',
  quotation_not_sent: 'This quotation is not open for an answer',
  quotation_expired: 'This quotation has expired',
  quotation_closed: 'This quotation is no longer open',
  quotation_pdf_not_ready: 'The PDF of this quotation version is not ready to download',
  quotation_pdf_failed: 'The PDF could not be prepared',
  quotation_pdf_unavailable: 'This PDF is not available',
  quotation_pdf_retry_not_needed: 'The PDF has not failed, so there is nothing to retry',
  invoice_pdf_not_ready: 'The PDF of this invoice is still being prepared',
  invoice_pdf_failed: 'The PDF could not be prepared',
  invoice_pdf_unavailable: 'This PDF is not available',
  invoice_pdf_scan_refused: 'The virus scan refused this PDF, so it cannot be served',
  invoice_pdf_retry_not_needed: 'The PDF has not failed, so there is nothing to retry',
  purchase_order_pdf_not_ready: 'The PDF of this purchase order is still being prepared',
  purchase_order_pdf_failed: 'The PDF could not be prepared',
  purchase_order_pdf_unavailable: 'This PDF is not available',
  purchase_order_pdf_scan_refused: 'The virus scan refused this PDF, so it cannot be served',
  purchase_order_pdf_retry_not_needed: 'The PDF has not failed, so there is nothing to retry',
  kyb_not_verified: 'Portal access needs an approved KYB verification case',
  customer_merged: 'This customer was merged into another',
  idp_org_taken: 'The portal organization is already used by another party',
  first_admin_owner_only: "Only the customer's account owner can invite its first portal admin",
  account_owner_missing: 'This customer has no account owner to invite its first portal admin',
  invalid_transition: 'This action is not allowed in the current status',
  kyb_not_submitted: 'The KYB verification has not been submitted yet',
  kyc_expired: 'The vendor tax clearance has expired',
  vendor_not_editable: 'This vendor can no longer be edited',
  vendor_identity_locked: 'The legal name and tax numbers of an approved vendor cannot be changed',
  customer_identity_locked:
    'The legal name, PAN and country of a verified customer cannot be edited',
  account_exists: 'This vendor already has this bank account',
  no_verified_bank_account: 'The vendor has no verified bank account',
  callback_evidence_not_clean: 'The call-back evidence has not passed the virus scan',
  document_infected: 'A virus was found in this file. Remove it or upload a clean copy.',
  NO_ELIGIBLE_APPROVER: 'No one is eligible to approve this; an administrator has been told',
  APPROVER_NOT_ELIGIBLE: 'The chosen approver cannot approve this',
  evidence_policy_unmet: 'The evidence given does not meet the policy',
  decided_on_in_future: 'The decision date is in the future',
  quotation_not_accepted: 'Only an accepted quotation can be confirmed',
  evidence_not_filed: 'This order was already confirmed, so the named files were not filed with it',
  draft_of_other_revision: 'This quotation already has a draft sales order of another revision',
  credit_hold:
    'With its receivables, its orders not yet invoiced and this order, the customer is over its credit limit; the deal needs a credit override first',
  sales_order_not_open: 'This sales order is not open for this change',
  delivery_already_released: 'The delivery of this sales order is already released',
  contact_activity_required: 'Log a call, email or meeting before moving this lead to Contacted.',
  schedule_line_not_planned: 'This schedule line is no longer planned',
  SCHEDULE_LINE_TAKEN: 'This billing schedule line already has an invoice',
  NOT_APPROVED: 'This invoice is issued only after it has been approved',
  DUE_DATE_BEFORE_ISSUE: 'The due date is before the issue date',
  CREDIT_EXCEEDS_INVOICE: 'The credit notes of this invoice would total more than the invoice',
  OVER_ALLOCATION: 'The amount is more than the balance still open on an item',
  MISMATCHED_ITEMS: 'The allocation items do not match',
  payment_not_submitted: 'This payment is not waiting for verification',
  payment_not_verified: 'Only a verified payment can be reversed',
  proof_not_clean: 'Every proof must pass the virus scan first',
  invoice_not_open:
    'Only an issued invoice or debit note with an amount still owed can take a promise to pay',
  promise_open: 'This invoice already has an open promise to pay',
  invalid_proof: 'A proof file is not valid for this payment',
  unknown_customer: 'No such customer',
  unknown_withholding_code: 'No such withholding code',
  reason_required: 'A reason is required',
  invalid_evidence_document: 'An evidence document does not exist or was removed',
  invalid_payment_schedule: 'The payment schedule is not valid',
  evidence_required: 'This step needs an evidence document',
  over_receipt: 'This receipt takes more than the quantity still open on the purchase order line',
  over_receipt_exception_unknown: 'The over-receipt exception is not known for this receipt line',
  po_line_unknown: 'A receipt line names a purchase order line that is not on this order',
  duplicate_po_line: 'The same purchase order line appears twice in this receipt',
  receipt_kind_mismatch: 'This receipt line does not match the kind of the receipt',
  serials_required: 'This line needs one serial number for each unit received',
  serials_not_allowed: 'This line does not take serial numbers',
  serial_duplicate: 'A serial number was already received on this purchase order line',
  RECEIPT_DATE_IN_FUTURE: 'The receipt date is after today',
  BILL_DATE_IN_FUTURE: 'The invoice date is after today',
  VENDOR_NOT_APPROVED: 'The vendor is not approved for this action',
  VENDOR_NOT_IN_ENTITY: 'A vendor has no account in this entity',
  FEWER_THAN_MIN_QUOTES: 'There are fewer quotations than the minimum; give a reason to go on',
  rfq_deadline_passed: 'The quotation deadline of this RFQ has passed',
  PO_HAS_RECEIPTS: 'Goods or services were received on this purchase order',
  PO_HAS_BILLS: 'Vendor bills still refer to this purchase order',
  PO_HAS_NO_LINES: 'The purchase order has no lines',
  PO_VENDOR_CHANGE_NOT_DRAFT: 'Cancel this order and create a new one',
  PO_VENDOR_UNCHANGED: 'The purchase order already has this vendor',
  PO_VENDOR_CHANGE_NO_RFQ:
    'This draft has no RFQ, so the new vendor has no quotation; create a new purchase order',
  PO_VENDOR_NO_QUOTATION: "The new vendor has no quotation on this order's RFQ",
  PO_VENDOR_CHANGE_PENDING: 'A change of vendor on this order is waiting for approval',
  VENDOR_CURRENCY_NOT_SUPPORTED: 'The vendor cannot trade in the currency of this order',
  VENDOR_NOT_VAT_REGISTERED:
    'The order carries VAT and the vendor is not VAT registered; confirm to go on',
  PO_REFERENCED:
    'Payment requests or bills already refer to this order; cancel it and create a new one',
  PO_CHANGED: 'This purchase order changed since you opened it. Reload and try again.',
  VENDOR_NO_VERIFIED_BANK_ACCOUNT: 'The vendor has no verified bank account',
  PO_AMENDMENT_INVALID: 'This amendment cannot be applied to the purchase order',
  DUPLICATE_BILL: 'This vendor already has a bill with this invoice number in the fiscal year',
  BILL_NOT_MATCHED: 'Every line must match, or a match exception be approved, to submit this bill',
  BILL_DOCUMENT_NOT_CLEAN: 'The invoice file must scan clean before this bill can be submitted',
  PO_NOT_BILLABLE: 'A purchase order in this status cannot be billed',
  MATCH_NOT_REQUIRED: 'A bill without a purchase order is not matched',
  BILL_NOT_POSTED: 'This bill has no payable item to void yet',
  BILL_HAS_ALLOCATIONS: 'Part of this bill is already paid or settled, so it cannot be voided',
  BILL_KIND_NOT_SUPPORTED: 'Only bills can be keyed in for now',
  CURRENCY_NOT_SUPPORTED: 'Only NPR bills can be keyed in for now',
  CURRENCY_NOT_ENABLED: 'This currency is not enabled for this company',
  BILL_HAS_PAYMENT_REQUEST:
    'A payment request waiting for approval or already approved is on this bill, so it cannot be voided',
  SUBMISSION_NOT_RECEIVED: 'This portal submission is no longer waiting for review',
  SUBMISSION_FILE_NOT_CLEAN: 'The submitted file has not scanned clean',
  SUBMISSION_HAS_NO_VENDOR: 'This portal submission names no vendor',
  SUBMISSION_INCOMPLETE: 'This portal submission has no invoice number or invoice date',
  SUBMISSION_MISMATCH: 'The bill does not match the portal submission it is keyed from',
  DOCUMENT_NOT_FOUND: 'The invoice file was not found',
  PO_REQUIRED: 'A line linked to a purchase order line needs the purchase order',
  PO_LINE_REQUIRED: 'A bill line needs its purchase order line',
  PO_LINE_NOT_FOUND: 'A bill line names a purchase order line that is not on this order',
  RECEIPT_LINE_NOT_FOUND: 'A receipt line is not a receipt of its purchase order line',
  PO_VENDOR_MISMATCH: 'The purchase order is for another vendor',
  TAX_CODE_NOT_FOUND: 'A tax code was not found',
  WITHHOLDING_CODE_NOT_FOUND: 'A withholding code was not found',
  ADVANCE_NOT_SUPPORTED: 'Only settlements of approved bills can be requested for now',
  DUPLICATE_OPEN_ITEM: 'The same payable item appears twice in this payment request',
  NOT_A_VENDOR_BILL_ITEM: 'A line is not a payable item of a bill of this vendor',
  BILL_NOT_PAYABLE: 'A line names a bill that is not approved for payment',
  CURRENCY_MISMATCH: 'The payable items of a payment request must all be in one currency',
  PURCHASE_ORDER_NOT_FOUND: 'This vendor has no such purchase order',
  BANK_ACCOUNT_INVALID: 'Choose an active bank account of this company',
  BANK_ACCOUNT_CURRENCY_MISMATCH: 'The bank account holds another currency than this payment',
  EXPENSE_ACCOUNT_INVALID: 'Choose an active expense account for every line',
  confirmation_required: 'Confirm the warning before saving these access changes.',
  last_founder: 'Cannot remove the only Founder. Make someone else a Founder first.',
  unprocessable: 'The submitted data cannot be processed',
  supporting_document_unsupported:
    'A supporting document cannot be attached to a bank change request yet',
  payload_too_large: 'Payload too large',
  unsupported_media_type: 'Unsupported media type',
  bad_request: 'Bad request',
  unavailable: 'Service unavailable',
  db_busy: 'Busy, please try again',
  internal: 'Internal server error',
};

/** Pulls the text out of an HttpException body: a string, `{ message: string }` or `{ message: string[] }`. */
function messageOf(exception: HttpException): string | undefined {
  const response = exception.getResponse();
  if (typeof response === 'string') return response;
  if ('message' in response) {
    const { message } = response;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) {
      return message.filter((m): m is string => typeof m === 'string').join('; ');
    }
  }
  return undefined;
}

/**
 * The optional `reason` a 403 or a 400 can carry, e.g. `new ForbiddenException({ code: 'forbidden',
 * reason: 'out_of_scope' })`. Only the known reasons pass, so the body always satisfies
 * ErrorBodySchema and a stray string from a thrown object never reaches the client.
 */
function reasonOf(exception: HttpException): ErrorReason | undefined {
  const response = exception.getResponse();
  if (typeof response !== 'object' || !('reason' in response)) return undefined;
  const parsed = ErrorReasonSchema.safeParse(response.reason);
  return parsed.success ? parsed.data : undefined;
}

/**
 * True for a 401 thrown with `code: 'step_up_required'` (StepUpRequiredException, K7). Only a 401
 * may carry it, so no other error can tell the client to re-authenticate.
 */
function isStepUp(exception: HttpException): boolean {
  if (exception.getStatus() !== 401) return false;
  const response = exception.getResponse();
  return typeof response === 'object' && 'code' in response && response.code === STEP_UP_REQUIRED;
}

/**
 * A 409 may name its cause with a code a client can switch on. Only these pass: any other string a thrown
 * object carries still reads as plain `conflict`, so the body stays within what clients know.
 */
const CONFLICT_CODES: readonly ErrorCode[] = [
  'stale_access',
  'fx_rate_stale',
  'duplicate_pan_vat',
  'duplicate_found',
  'primary_contact_exists',
  // Q3b/PA-3: the quotation version was already answered, revised or expired (`quotation_not_sent`), or its
  // validity ended before the decision day (`quotation_expired`). The portal shows "already answered".
  'quotation_not_sent',
  'quotation_expired',
  // R5 EF2: the portal link of a sent version that was cancelled (a Lost deal); the page says it is no longer open.
  'quotation_closed',
  // The staff PDF download: the version has no rendered file yet, or it has not scanned clean.
  'quotation_pdf_not_ready',
  // K8 portal access grant: the customer's KYB case is not approved, the customer was merged away, or the
  // portal org found by name is already linked to another party.
  'kyb_not_verified',
  'customer_merged',
  'idp_org_taken',
  // F1-Q31: the customer has no portal user yet and the caller is not its account owner, or it has no owner.
  'first_admin_owner_only',
  'account_owner_missing',
  // U8 sales orders: only an accepted quotation confirms, only a confirmed order marks a line, only a planned
  // line becomes billable.
  'quotation_not_accepted',
  // R5 FU10: a confirm of an already confirmed order named files the order does not have; nothing was filed.
  'evidence_not_filed',
  // R5 FX5: the quotation already has a draft order of another revision; the client points to that draft.
  'draft_of_other_revision',
  // F1-Q20/F1-Q26: receivables, uninvoiced orders and this order are over the credit limit and the deal has no
  // override that covers the order (`details`: the opportunity id only; the limit and amounts are for
  // credit.override holders).
  'credit_hold',
  'sales_order_not_open',
  'delivery_already_released',
  'contact_activity_required',
  'schedule_line_not_planned',
  // U10 invoices: the line already has a live invoice; a tax invoice, credit or debit note needs approval first.
  'SCHEDULE_LINE_TAKEN',
  'NOT_APPROVED',
  // U12 credit notes: drafting or issuing one would credit more than the invoice total (done check 7).
  'CREDIT_EXCEEDS_INVOICE',
  // The ledger refuses amounts above either open balance.
  'OVER_ALLOCATION',
  // U7 payments: verify and reject need a submitted payment, reverse a verified one, verify needs clean proofs.
  'payment_not_submitted',
  'payment_not_verified',
  'proof_not_clean',
  // F1-Q33 promises to pay: the invoice owes nothing (or is not issued), or an open promise cannot be replaced
  // (recorded concurrently, or its day has passed and the hourly job has not checked it yet).
  'invoice_not_open',
  'promise_open',
  // P4 vendors (V1) and vendor bank accounts (V2): lifecycle and maker-checker refusals a client can switch on.
  'invalid_transition',
  'kyb_not_submitted',
  'kyc_expired',
  'vendor_not_editable',
  'vendor_identity_locked',
  'customer_identity_locked',
  'account_exists',
  'no_verified_bank_account',
  'callback_evidence_not_clean',
  // TR-Q12e: a bill, evidence, quotation, KYC or portal submission names a file the scan found infected.
  'document_infected',
  // P4 sourcing: an invited vendor is not approved or has no account in the entity, or a recommendation is
  // short of the minimum number of quotations without a reason (AD13).
  'VENDOR_NOT_APPROVED',
  'VENDOR_NOT_IN_ENTITY',
  'FEWER_THAN_MIN_QUOTES',
  // F1-Q47: a quotation (typed in, converted or sent from the vendor portal) arrived after the RFQ's deadline.
  'rfq_deadline_passed',
  // P4 purchase orders: issue with no lines, cancel or close after something was received. Issuing also
  // throws VENDOR_NOT_APPROVED and VENDOR_NOT_IN_ENTITY.
  'PO_HAS_RECEIPTS',
  // K3 Q3: cancel (or cancel and raise again) while a bill that is not voided names the order.
  'PO_HAS_BILLS',
  'PO_HAS_NO_LINES',
  // F1-Q40 a: changing the vendor of a PO that is not a draft, to the vendor it already has, of a draft a payment
  // request, bill or portal submission already refers to, or to a vendor without a verified bank account.
  'PO_VENDOR_CHANGE_NOT_DRAFT',
  'PO_VENDOR_UNCHANGED',
  'PO_REFERENCED',
  // K3 Q1/Q2: the vendor swap needs the new vendor's own quotation on the order's RFQ, a matching currency, and the
  // VAT warning acknowledged; an earlier swap waiting for approval blocks issue and a second swap.
  'PO_VENDOR_CHANGE_NO_RFQ',
  'PO_VENDOR_NO_QUOTATION',
  'PO_VENDOR_CHANGE_PENDING',
  'VENDOR_CURRENCY_NOT_SUPPORTED',
  'VENDOR_NOT_VAT_REGISTERED',
  'VENDOR_NO_VERIFIED_BANK_ACCOUNT',
  // Issuing a draft from a page that read an older version (a vendor change by another buyer since).
  'PO_CHANGED',
  // P4 vendor bills (payables): a duplicate invoice number, a PO that cannot be billed, a bill not matched or
  // not required to match, and a void of a bill with no payable item or with payments already allocated.
  'DUPLICATE_BILL',
  'BILL_NOT_MATCHED',
  'BILL_DOCUMENT_NOT_CLEAN',
  'PO_NOT_BILLABLE',
  'MATCH_NOT_REQUIRED',
  'BILL_NOT_POSTED',
  'BILL_HAS_ALLOCATIONS',
  'BILL_HAS_PAYMENT_REQUEST',
  // P4 portal bill submissions (payables): converting or rejecting one that is no longer received, or whose file
  // has not scanned clean.
  'SUBMISSION_NOT_RECEIVED',
  'SUBMISSION_FILE_NOT_CLEAN',
  // P4 payment requests: a line asks for more than the open balance of its payable item, net of the other live
  // requests' claims (the ledger's OVER_ALLOCATION, with the item and the amounts in `details`).
  'OVER_ALLOCATION',
  // U20b access settings: optimistic-lock mismatch, unacknowledged confirm warnings, and removing the sole Founder.
  'stale_access',
  'confirmation_required',
  'last_founder',
  // U20b retire: someone joined or left the department after the dialog showed its people.
  'members_changed',
];

function conflictCodeOf(exception: HttpException): ErrorCode | undefined {
  if (exception.getStatus() !== 409) return undefined;
  const response = exception.getResponse();
  if (typeof response !== 'object' || !('code' in response)) return undefined;
  return CONFLICT_CODES.find((code) => code === response.code);
}

/**
 * A 422 may name its cause the same way. `NO_ELIGIBLE_APPROVER` (P2 M4, upper case as the plan names it): a
 * quotation submit found an approval step nobody may decide, so nothing was submitted and admins were told.
 * `evidence_policy_unmet` and `decided_on_in_future` (Q3b/PA-3): an acceptance without the evidence the entity's
 * policy asks for, or an answer dated after today in Kathmandu.
 */
const UNPROCESSABLE_CODES: readonly ErrorCode[] = [
  // The ledger refuses allocations across parties/currencies or closed items.
  'MISMATCHED_ITEMS',
  'contact_email_required',
  'NO_ELIGIBLE_APPROVER',
  // A quotation submit named an approver who may not decide its first step (or the author themselves).
  'APPROVER_NOT_ELIGIBLE',
  'evidence_policy_unmet',
  'decided_on_in_future',
  // P3 invoice issue: the drafted due date is before today, the issue date (R4c1 U15b-Q5).
  'DUE_DATE_BEFORE_ISSUE',
  // U7 payments: a proof that is not a clean file for this customer, an unknown customer or withholding code,
  // a rejection or reversal without a reason.
  'invalid_proof',
  'unknown_customer',
  'unknown_withholding_code',
  'reason_required',
  // U8 sales orders: an evidence document that is missing or gone, or a payment schedule that does not add up.
  'invalid_evidence_document',
  'invalid_payment_schedule',
  'evidence_required',
  // P4 goods receipts (RECEIPT_ERROR_CODES in receipt.rules.ts): over-receipt, bad PO lines and serial numbers.
  'over_receipt',
  'over_receipt_exception_unknown',
  'po_line_unknown',
  'duplicate_po_line',
  'receipt_kind_mismatch',
  'serials_required',
  'serials_not_allowed',
  'serial_duplicate',
  // FX6: a receipt dated after today in Kathmandu (create and confirm).
  'RECEIPT_DATE_IN_FUTURE',
  // P4 purchase orders: an amendment names a line of another order, changes nothing, or cuts below what arrived.
  'PO_AMENDMENT_INVALID',
  // P4 vendor bills (payables): what the bill entry and the match refuse (a request the server will not take
  // as it stands: an unsupported kind or currency, a portal submission that cannot become the bill, or a file,
  // PO, line or code it cannot find).
  'BILL_KIND_NOT_SUPPORTED',
  'CURRENCY_NOT_SUPPORTED',
  'CURRENCY_NOT_ENABLED',
  // FX6: an invoice dated after today in Kathmandu (bill entry, a converted or a new portal submission).
  'BILL_DATE_IN_FUTURE',
  'SUBMISSION_HAS_NO_VENDOR',
  'SUBMISSION_INCOMPLETE',
  'SUBMISSION_MISMATCH',
  'DOCUMENT_NOT_FOUND',
  'PO_REQUIRED',
  'PO_LINE_REQUIRED',
  'PO_LINE_NOT_FOUND',
  'RECEIPT_LINE_NOT_FOUND',
  'PO_VENDOR_MISMATCH',
  'TAX_CODE_NOT_FOUND',
  'WITHHOLDING_CODE_NOT_FOUND',
  // P4 payment requests: what the request entry refuses (an advance, an item named twice, an item that is not a
  // payable of this vendor's approved bill, a currency mix, a PO of another vendor). Submit also throws
  // NO_ELIGIBLE_APPROVER.
  'ADVANCE_NOT_SUPPORTED',
  'DUPLICATE_OPEN_ITEM',
  'NOT_A_VENDOR_BILL_ITEM',
  'BILL_NOT_PAYABLE',
  'CURRENCY_MISMATCH',
  'PURCHASE_ORDER_NOT_FOUND',
  // Round 5 P1: a paying bank account that is not an active company account of the entity, or of another currency.
  'BANK_ACCOUNT_INVALID',
  'BANK_ACCOUNT_CURRENCY_MISMATCH',
  'EXPENSE_ACCOUNT_INVALID',
  // Global whitelist: staff and vendor-portal KYC 422s retain `unprocessable` for checklist or expiry
  // refusals; vendor bank changes retain their supporting-file refusal.
  'unprocessable',
  'supporting_document_unsupported',
];

/**
 * The state of a staff PDF download (and of its Retry), each code bound to the one status its service throws it with:
 * not ready (409, the render is still trying), failed (424, the render was given up), unavailable (404, there is no
 * file to serve), scan refused (404, the virus scan refused the stored file) and retry not needed (409). A code passes
 * only with its own status, so a screen can switch on it (P5's portal pending and failed states); anything else reads
 * as the plain code of its status. `quotation_pdf_not_ready` is in CONFLICT_CODES, from before this list.
 */
const PDF_STATE_CODES: Readonly<Partial<Record<ErrorCode, number>>> = {
  quotation_pdf_failed: 424,
  quotation_pdf_unavailable: 404,
  quotation_pdf_retry_not_needed: 409,
  invoice_pdf_not_ready: 409,
  invoice_pdf_failed: 424,
  invoice_pdf_unavailable: 404,
  invoice_pdf_scan_refused: 404,
  invoice_pdf_retry_not_needed: 409,
  purchase_order_pdf_not_ready: 409,
  purchase_order_pdf_failed: 424,
  purchase_order_pdf_unavailable: 404,
  purchase_order_pdf_scan_refused: 404,
  purchase_order_pdf_retry_not_needed: 409,
};

function pdfStateCodeOf(exception: HttpException): ErrorCode | undefined {
  const response = exception.getResponse();
  if (typeof response !== 'object' || !('code' in response)) return undefined;
  const code = (Object.keys(PDF_STATE_CODES) as ErrorCode[]).find((c) => c === response.code);
  return code !== undefined && PDF_STATE_CODES[code] === exception.getStatus() ? code : undefined;
}

function unprocessableCodeOf(exception: HttpException): ErrorCode | undefined {
  if (exception.getStatus() !== 422) return undefined;
  const response = exception.getResponse();
  if (typeof response !== 'object' || !('code' in response)) return undefined;
  return UNPROCESSABLE_CODES.find((code) => code === response.code);
}

/** The `details` of a coded 409: string and number values only, so the body satisfies ErrorBodySchema. */
function detailsOf(exception: HttpException): Record<string, string | number> | undefined {
  const response = exception.getResponse();
  if (typeof response !== 'object' || !('details' in response)) return undefined;
  const parsed = ErrorBodySchema.shape.error.shape.details.safeParse(response.details);
  return parsed.success ? parsed.data : undefined;
}

/**
 * One possible duplicate of a lead's customer or contact. The same shape the workspace parses in
 * `apps/workspace/src/components/p2/crm/duplicates.ts`: for a contact, `customerId` names the customer it
 * belongs to, so "use existing" can link both.
 */
export const DuplicateCandidateSchema = z.strictObject({
  kind: z.enum(['customer', 'contact']),
  id: z.guid(),
  label: z.string().max(300),
  /** What matched: name, pan, email or phone. */
  matchedOn: z.string().max(50),
  customerId: z.guid().optional(),
});
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;

const DuplicateListSchema = z.array(DuplicateCandidateSchema).min(1).max(50);

/**
 * The candidates of a `duplicate_found` 409, validated so a stray object never reaches the client. They go to
 * `error.duplicates` (a sibling of `code`, not inside `details`, which only holds strings and numbers).
 * ErrorBodySchema is not strict, so a client that parses with it still accepts the body.
 */
function duplicatesOf(exception: HttpException): DuplicateCandidate[] | undefined {
  const response = exception.getResponse();
  if (typeof response !== 'object' || !('duplicates' in response)) return undefined;
  const parsed = DuplicateListSchema.safeParse(response.duplicates);
  return parsed.success ? parsed.data : undefined;
}

const AccessWarningListSchema = z.array(AccessWarningSchema).min(1).max(100);
const FieldErrorsSchema = z.record(z.string(), z.string());

/** Validated warnings carried by `confirmation_required` (409) or blocked access saves (422). */
function warningsOf(exception: HttpException): AccessWarning[] | undefined {
  const response = exception.getResponse();
  if (typeof response !== 'object' || !('warnings' in response)) return undefined;
  const parsed = AccessWarningListSchema.safeParse(response.warnings);
  return parsed.success ? parsed.data : undefined;
}

/** Validated per-field errors carried by a 422 `unprocessable` refusal. */
function fieldErrorsOf(exception: HttpException): Record<string, string> | undefined {
  const response = exception.getResponse();
  if (typeof response !== 'object' || !('fieldErrors' in response)) return undefined;
  const parsed = FieldErrorsSchema.safeParse(response.fieldErrors);
  if (!parsed.success || Object.keys(parsed.data).length === 0) return undefined;
  return parsed.data;
}

/** What `routeOf` returns when Express matched no route (a middleware refused the request first). */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * The matched route pattern (`/v1/approvals/requests/:id`), else `UNMATCHED_ROUTE`. Never the request path:
 * a path carries record ids, and the query string can carry a searched name. Nest mounts controller routes on
 * the root router, so their `baseUrl` is empty. A non-empty `baseUrl` is the concrete path a middleware was
 * mounted at (`/v1/blocked/<id>`), and `req.route` is then left over from an earlier layer, so neither is used.
 */
export function routeOf(req: { route?: unknown; baseUrl?: string }): string {
  const route = req.route as { path?: unknown } | undefined;
  if (typeof route?.path !== 'string' || (req.baseUrl ?? '') !== '') return UNMATCHED_ROUTE;
  return route.path;
}

/** The fields of one `http.forbidden` line. Every value is a fixed vocabulary or the response's request id. */
interface ForbiddenEvent {
  event: 'http.forbidden';
  status: 403;
  method: string;
  route: string;
  code: ErrorCode;
  reason: ErrorReason | null;
  correlationId: string;
}

/**
 * Writes the `http.forbidden` line with the root pino logger, not the per-request one. nestjs-pino's request
 * logger is bound to the serialized request (url with query string, params, client address, headers), and every
 * line written through it carries those bindings. The root logger has only the base fields and the redaction of
 * `buildLoggerParams`. Without nestjs-pino (unit tests, a bare Nest app) the Nest logger has no request bindings
 * either, so it is the fallback.
 */
function logForbidden(fallback: Logger, event: ForbiddenEvent): void {
  // Unset until nestjs-pino's LoggerModule builds its middleware, although the type says otherwise.
  const root: PinoLogger['logger'] | undefined = PinoLogger.root;
  if (root === undefined) {
    fallback.warn({ msg: 'request forbidden', ...event });
    return;
  }
  root.warn({ context: 'ErrorBodyFilter', ...event }, 'request forbidden');
}

/** body-parser and other Express middleware throw plain errors that carry an HTTP status. */
function statusOfPlainError(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const { status, statusCode } = exception as { status?: unknown; statusCode?: unknown };
  const value = typeof status === 'number' ? status : statusCode;
  return typeof value === 'number' && value >= 400 && value <= 599 ? value : undefined;
}

/**
 * Turns every exception into `{ error: { code, message, correlationId, reason? } }` (ErrorBodySchema).
 *
 * Leak rules: a server-side failure (any 5xx except 503) always returns a fixed message; the real
 * error and its stack go only to the log, next to the correlation id so support can find them.
 * Responses never contain a stack.
 */
@Catch()
export class ErrorBodyFilter implements ExceptionFilter {
  private readonly logger = new Logger(ErrorBodyFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      throw exception;
    }
    const http = host.switchToHttp();
    const req = http.getRequest<CorrelatedRequest>();
    const res = http.getResponse<Response>();

    // An upload whose bytes were kept and only its scan could not be queued yet: accepted (202) with the quarantined
    // version, on every upload route (the sweeper queues the scan). Sent here because Nest resets a status set in a handler.
    if (exception instanceof ScanQueueDeferredError) {
      res.status(202).json(exception.version);
      return;
    }

    let status: number;
    let exposedMessage: string | undefined;
    let reason: ErrorReason | undefined;
    let stepUp = false;
    let conflictCode: ErrorCode | undefined;
    let details: Record<string, string | number> | undefined;
    let duplicates: DuplicateCandidate[] | undefined;
    let warnings: AccessWarning[] | undefined;
    let fieldErrors: Record<string, string> | undefined;
    let busy: DbBusyKind | undefined;
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      exposedMessage = messageOf(exception);
      // 403 for authz denials; 400 for `invalid_entity` (a malformed X-Entity-Id, ADR 0027 §4); 409 for a stale
      // memo or a customer-terms form rendered for another acting entity (`entity_changed`).
      const reportedReason = reasonOf(exception);
      if (
        status === 403 ||
        status === 400 ||
        (status === 409 && (reportedReason === 'stale_memo' || reportedReason === 'entity_changed'))
      ) {
        reason = reportedReason;
      }
      stepUp = isStepUp(exception);
      conflictCode =
        conflictCodeOf(exception) ?? unprocessableCodeOf(exception) ?? pdfStateCodeOf(exception);
      if (conflictCode !== undefined) details = detailsOf(exception);
      // A refused hand-over names its rule (`details.assignmentReason`) so the client can say why; nothing
      // else rides on a plain 400.
      else if (status === 400) {
        const reasonCode = detailsOf(exception)?.assignmentReason;
        if (typeof reasonCode === 'string') details = { assignmentReason: reasonCode };
      }
      if (conflictCode === 'duplicate_found') duplicates = duplicatesOf(exception);
      if (conflictCode === 'confirmation_required' || conflictCode === 'unprocessable') {
        warnings = warningsOf(exception);
      }
      if (conflictCode === 'unprocessable') {
        fieldErrors = fieldErrorsOf(exception);
      }
    } else {
      busy = dbBusyKindOf(exception);
      status =
        busy === undefined
          ? (statusOfPlainError(exception) ?? HttpStatus.INTERNAL_SERVER_ERROR)
          : HttpStatus.SERVICE_UNAVAILABLE;
    }

    const code: ErrorCode =
      busy !== undefined
        ? 'db_busy'
        : stepUp
          ? 'step_up_required'
          : (conflictCode ?? codeForStatus(status));
    // 5xx other than 503 may carry internal detail in the message, so those are never shown.
    const message =
      status >= 500 && status !== 503
        ? GENERIC_MESSAGE.internal
        : (exposedMessage ?? GENERIC_MESSAGE[code]);
    const correlationId = this.correlationIdFor(req);

    if (busy !== undefined) {
      this.logger.warn(
        `${req.method} ${req.path} rolled back: database ${busy} (correlationId=${correlationId})`,
      );
    } else if (status >= 500) {
      // req.path excludes the query string, which could carry secrets.
      const stack = exception instanceof Error ? exception.stack : String(exception);
      this.logger.error(
        `${req.method} ${req.path} failed with ${status} (correlationId=${correlationId})`,
        stack,
      );
    }

    if (status === 403) {
      // One structured line per denial, so a 403 the client shows can be traced to the check that made it
      // (role, entity, scope, separation of duties ...). Only the fields listed here: no url, query, ids, user,
      // token or body. The correlation id (also in the response header) links it to the request log.
      logForbidden(this.logger, {
        event: 'http.forbidden',
        status: 403,
        method: req.method,
        route: routeOf(req),
        code,
        reason: reason ?? null,
        correlationId,
      });
    }

    if (res.headersSent) {
      return;
    }
    // The same seconds as the Retry-After header, in the body too: a caller that turns the response into its own
    // (the workspace BFF) reads the body, and does not see this response's headers.
    if (busy !== undefined) details = { retryAfterSeconds: DB_BUSY_RETRY_AFTER_SECONDS[busy] };
    const body: ErrorBody & {
      error: {
        duplicates?: DuplicateCandidate[];
        warnings?: AccessWarning[];
        fieldErrors?: Record<string, string>;
      };
    } = {
      error: {
        code,
        message,
        correlationId,
        ...(reason === undefined ? {} : { reason }),
        ...(details === undefined ? {} : { details }),
        ...(duplicates === undefined ? {} : { duplicates }),
        ...(warnings === undefined ? {} : { warnings }),
        ...(fieldErrors === undefined ? {} : { fieldErrors }),
      },
    };
    res.setHeader(REQUEST_ID_HEADER, correlationId);
    if (busy !== undefined) res.setHeader('Retry-After', String(DB_BUSY_RETRY_AFTER_SECONDS[busy]));
    res.status(status).json(body);
  }

  /** The request's id from the async context, else the request header, else a fresh one. Always valid. */
  private correlationIdFor(req: CorrelatedRequest): string {
    const header = req.headers[REQUEST_ID_HEADER];
    return (
      currentCorrelationId() ??
      req.correlationId ??
      newCorrelationId(typeof header === 'string' ? header : undefined)
    );
  }
}
