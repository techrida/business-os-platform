import { currencyNotEnabledText } from '@/lib/kernel-ui';

import { failureWith, type ProcFailure } from '../../procurement/orders/_lib/failure-core';

export function paymentRequestFailure(err: unknown): ProcFailure {
  // A currency switched off for the company (D44). Read before the code map: until the API passes
  // CURRENCY_NOT_ENABLED, its 422 says `bad_request` and only the message names the currency.
  const switchedOff = currencyNotEnabledText(err);
  if (switchedOff !== undefined) {
    return { message: switchedOff, reload: false, definite: true, status: 422 };
  }
  return failureWith(err, {
    notFound: 'This payment request, vendor or payable item was not found in this legal entity.',
    noPermission:
      'Your roles do not allow payment requests. Ask an administrator if you need access.',
    conflictFallback:
      'The payment request changed. Reload to see its status. Only a draft can be submitted or cancelled.',
    conflict: (code) => {
      if (code === 'no_verified_bank_account')
        return {
          message:
            'The vendor needs an active, verified bank account before you can request payment.',
          reload: false,
        };
      if (code === 'OVER_ALLOCATION')
        return {
          message:
            'An amount exceeds what is open after other payment requests have claimed their share. Check the bill and reduce the amount.',
          reload: false,
        };
      if (code === 'BILL_NOT_PAYABLE')
        return {
          message:
            'A bill is no longer payable. Check its current status before starting another request.',
          reload: true,
        };
      return undefined;
    },
    unprocessable: (code) => {
      const messages: Record<string, string> = {
        NO_ELIGIBLE_APPROVER:
          'No eligible Finance approver is available. The requester, bill enterer and bill approvers cannot approve this request. Ask an administrator to check the approvers.',
        ADVANCE_NOT_SUPPORTED: 'Only settlements of approved bills are available.',
        DUPLICATE_OPEN_ITEM: 'Each payable item can appear only once. Remove the duplicate line.',
        NOT_A_VENDOR_BILL_ITEM:
          'Choose an approved bill payable item for this vendor in this legal entity.',
        BILL_NOT_PAYABLE: 'A bill is not payable. Check its current status.',
        CURRENCY_MISMATCH: 'Every bill must use the request currency.',
        PURCHASE_ORDER_NOT_FOUND:
          'That purchase order does not belong to this vendor in this legal entity.',
      };
      return code === undefined ? undefined : messages[code];
    },
  });
}
