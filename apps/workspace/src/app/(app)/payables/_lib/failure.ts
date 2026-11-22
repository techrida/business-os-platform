import { INVALID_EVIDENCE } from '@/lib/evidence';

import { failureWith, type ProcFailure } from '../../procurement/orders/_lib/failure-core';

/**
 * Words for every refusal the payables bill screens can get, keyed on what the person was doing.
 * The codes are the API's own (upper case for the bill and inbox rules, `invalid_transition` for a
 * status that moved on). Only a 400 shows any API text, through `failureWith`.
 */

export type BillOp =
  'load' | 'match' | 'submit' | 'void' | 'convert' | 'reject' | 'exception' | 'create' | 'discard';

const MOVED: Record<BillOp, string> = {
  discard:
    'This bill can no longer be discarded. Only a draft can be. Reload to see where it stands.',
  create: 'The vendor or purchase order changed. Check its current status and try again.',
  load: 'This bill changed since you opened it. Reload and try again.',
  match: 'This bill can no longer be matched. Reload to see where it stands.',
  submit: 'This bill can no longer be submitted. Reload to see where it stands.',
  void: 'This bill can no longer be voided. Only an approved bill can be. Reload to see where it stands.',
  convert: 'This submission changed since you opened it. Reload the inbox and try again.',
  reject: 'This submission changed since you opened it. Reload the inbox and try again.',
  exception:
    'This bill is no longer awaiting a match exception. Reload to see its match and approval status.',
};

export function billFailure(err: unknown, op: BillOp): ProcFailure {
  const isSubmission = op === 'convert' || op === 'reject';
  return failureWith(err, {
    notFound: isSubmission
      ? 'We could not find that submission. It may have been handled already, or belong to another legal entity.'
      : 'We could not find that bill. It may belong to another legal entity.',
    noPermission:
      op === 'load'
        ? 'Your roles do not include vendor bills. They are for the accountants and finance.'
        : 'Your roles do not allow this. Bills are keyed in, matched and voided by the accountants. Ask an administrator if you need that role.',
    conflictFallback: MOVED[op],
    conflict: (code) => {
      switch (code) {
        case 'BILL_DOCUMENT_NOT_CLEAN':
          return {
            message:
              'The invoice file has not scanned clean. Reload the draft bill to check its scan status. If the file failed or was never uploaded, use "Upload a replacement file" on the bill.',
            reload: true,
          };
        case 'DUPLICATE_BILL':
          return {
            message:
              'This vendor already has a bill with this invoice number in this fiscal year. Check whether the invoice was keyed in before.',
            reload: false,
          };
        case 'SUBMISSION_FILE_NOT_CLEAN':
          return {
            message:
              'The vendor’s file has not passed its virus scan yet. Wait for the scan to finish, then reload the inbox.',
            reload: true,
          };
        case 'SUBMISSION_NOT_RECEIVED':
          return {
            message:
              'This submission was already handled: someone converted or rejected it. Reload the inbox to see what is left.',
            reload: true,
          };
        case 'PO_NOT_BILLABLE':
          return {
            message:
              'This purchase order cannot be billed in its current status. It must be issued or received on.',
            reload: false,
          };
        case 'BILL_NOT_MATCHED':
          return {
            message:
              'This bill is not matched to its purchase order and receipt yet, so it cannot be submitted. Match it again, or ask for an exception if it is outside tolerance.',
            reload: true,
          };
        case 'MATCH_NOT_REQUIRED':
          return {
            message: 'This bill has no purchase order, so there is nothing to match it against.',
            reload: true,
          };
        case 'BILL_NOT_POSTED':
          return {
            message: 'This bill has no payable item yet, so there is nothing to void. Reload.',
            reload: true,
          };
        case 'BILL_HAS_ALLOCATIONS':
          return {
            message:
              'A payment is already allocated to this bill, so it cannot be voided. Cancel the payment first.',
            reload: false,
          };
        case 'BILL_HAS_PAYMENT_REQUEST':
          return {
            message:
              'A payment request is open on this bill, so it cannot be voided. Cancel the payment request first.',
            reload: false,
          };
        case 'invalid_transition':
          return { message: MOVED[op], reload: true };
        default:
          return undefined;
      }
    },
    unprocessable: (code) => {
      switch (code) {
        case 'NO_ELIGIBLE_APPROVER':
          return 'This bill needs approval, but nobody can approve it right now. Nothing was changed. Ask an administrator to check the approvers for vendor bills.';
        case 'BILL_DATE_IN_FUTURE':
          return 'The invoice date is after today. Enter the date printed on the vendor’s invoice.';
        case 'SUBMISSION_HAS_NO_VENDOR':
          return 'The vendor did not name a vendor account, so a bill cannot be made from this submission. Reject it and ask the vendor to send it again.';
        case 'SUBMISSION_INCOMPLETE':
          return 'The vendor did not give an invoice number or invoice date, so a bill cannot be made from this submission. Reject it and ask the vendor to send it again.';
        case 'SUBMISSION_MISMATCH':
          return 'The bill does not match the submission it is keyed from. Reload the page and try again.';
        case 'PO_VENDOR_MISMATCH':
          return 'The purchase order is for another vendor. Check the order named on the submission.';
        case 'PO_LINE_REQUIRED':
        case 'PO_LINE_NOT_FOUND':
        case 'PO_REQUIRED':
          return 'A line does not fit the purchase order. On an order, every line must name a line of that order. Reload the page and try again.';
        case 'RECEIPT_LINE_NOT_FOUND':
          return 'A receipt line is not a receipt of its order line. Check the receipt you chose.';
        case 'DOCUMENT_NOT_FOUND':
          return op === 'exception'
            ? INVALID_EVIDENCE
            : 'The invoice file could not be found. Ask the vendor to send it again.';
        case 'invalid_evidence_document':
          return INVALID_EVIDENCE;
        case 'TAX_CODE_NOT_FOUND':
          return 'A VAT code on a line is not one of yours. Choose the VAT treatment again.';
        case 'WITHHOLDING_CODE_NOT_FOUND':
          return 'A withholding code on a line is not one that applies to payables. Check the ID.';
        case 'BILL_KIND_NOT_SUPPORTED':
        case 'CURRENCY_NOT_SUPPORTED':
          return 'Only NPR bills can be keyed in for now.';
        default:
          return undefined;
      }
    },
  });
}
