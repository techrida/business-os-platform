// Word-for-word copies of the P4 approval workflow specs that the API owns. This tool does not depend on
// apps/api, so it cannot import them; `apps/api/src/modules/procurement/workflow-seed-parity.test.ts` imports
// both sides and fails when they drift. This file has no imports on purpose, so that test can load it.
// Change a spec in the API first, then copy it here; never edit one side alone.

/**
 * Copy of PURCHASE_REQUEST_WORKFLOW_SPEC (apps/api/src/modules/procurement/requests/purchase-request.rules.ts).
 * `documentType` is the literal of PURCHASE_REQUEST_DOCUMENT_TYPE.
 */
export const PURCHASE_REQUEST_WORKFLOW_SPEC: unknown = {
  documentType: 'purchase_request',
  steps: [
    {
      id: 'department_head',
      kind: 'department_head',
      fallbackRole: 'operations_head',
      reason: 'Base route: the head of the requesting department approves the need',
    },
  ],
  rules: [
    {
      id: 'emergency',
      when: { field: 'isEmergency', op: 'eq', value: true },
      add: {
        id: 'management',
        kind: 'role',
        role: 'management',
        reason: 'Management approval because this is an emergency purchase request',
      },
      position: 'end',
      reason: 'Emergency purchase request',
    },
  ],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
};

/**
 * Copy of PR_COMMITMENT_WORKFLOW_SPEC (apps/api/src/modules/procurement/sourcing/sourcing.rules.ts).
 * `documentType` is the literal of PR_COMMITMENT_DOCUMENT_TYPE.
 */
export const PR_COMMITMENT_WORKFLOW_SPEC: unknown = {
  documentType: 'pr_commitment',
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: 'Base route: an Accountant checks the recommended quotation',
    },
    {
      id: 'finance',
      kind: 'role',
      role: 'finance',
      reason: 'Base route: Finance commits the budget',
    },
  ],
  rules: [
    {
      id: 'management',
      when: { field: 'amountNpr', op: 'gt', value: '100000.00' },
      add: {
        id: 'management',
        kind: 'role',
        role: 'management',
        reason: 'Management approval because the commitment exceeds NPR 100,000.00',
      },
      position: 'end',
      reason: 'Commitment of NPR {amountNpr} is above NPR 100,000.00',
    },
    {
      id: 'founder',
      when: {
        all: [
          { field: 'amountNpr', op: 'gt', value: '1000000.00' },
          { field: 'requesterIsFounder', op: 'eq', value: false },
        ],
      },
      add: {
        id: 'founder',
        kind: 'role',
        role: 'founder',
        reason: 'Founder approval because the commitment exceeds NPR 1,000,000.00',
      },
      position: 'end',
      reason: 'Commitment of NPR {amountNpr} is above NPR 1,000,000.00',
    },
    {
      id: 'management_second',
      when: {
        all: [
          { field: 'amountNpr', op: 'gt', value: '1000000.00' },
          { field: 'requesterIsFounder', op: 'eq', value: true },
        ],
      },
      add: {
        id: 'management_second',
        kind: 'role',
        role: 'management',
        reason: 'A second Management approval replaces the Founder, who raised this request (AD8)',
      },
      position: 'end',
      reason: 'The Founder raised a commitment of NPR {amountNpr}, above NPR 1,000,000.00',
    },
  ],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'management' } },
};

/**
 * Copy of PO_AMENDMENT_WORKFLOW_SPEC (apps/api/src/modules/procurement/orders/purchase-order.rules.ts).
 * `documentType` is the literal of PO_AMENDMENT_DOCUMENT_TYPE.
 */
export const PO_AMENDMENT_WORKFLOW_SPEC: unknown = {
  documentType: 'po_amendment',
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: 'Base route: an Accountant checks the amended purchase order',
    },
    {
      id: 'finance',
      kind: 'role',
      role: 'finance',
      reason: 'Base route: Finance commits the amended budget',
    },
  ],
  rules: [
    {
      id: 'management',
      when: { field: 'amountNpr', op: 'gt', value: '100000.00' },
      add: {
        id: 'management',
        kind: 'role',
        role: 'management',
        reason: 'Management approval because the amended order exceeds NPR 100,000.00',
      },
      position: 'end',
      reason: 'Amended order of NPR {amountNpr} is above NPR 100,000.00',
    },
    {
      id: 'founder',
      when: {
        all: [
          { field: 'amountNpr', op: 'gt', value: '1000000.00' },
          { field: 'requesterIsFounder', op: 'eq', value: false },
        ],
      },
      add: {
        id: 'founder',
        kind: 'role',
        role: 'founder',
        reason: 'Founder approval because the amended order exceeds NPR 1,000,000.00',
      },
      position: 'end',
      reason: 'Amended order of NPR {amountNpr} is above NPR 1,000,000.00',
    },
    {
      id: 'management_second',
      when: {
        all: [
          { field: 'amountNpr', op: 'gt', value: '1000000.00' },
          { field: 'requesterIsFounder', op: 'eq', value: true },
        ],
      },
      add: {
        id: 'management_second',
        kind: 'role',
        role: 'management',
        reason: 'A second Management approval replaces the Founder, who amended this order (AD8)',
      },
      position: 'end',
      reason: 'The Founder amended an order to NPR {amountNpr}, above NPR 1,000,000.00',
    },
  ],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'management' } },
};

/**
 * Copy of PO_VENDOR_CHANGE_WORKFLOW_SPEC (apps/api/src/modules/procurement/orders/po-vendor-change.rules.ts).
 * `documentType` is the literal of PO_VENDOR_CHANGE_DOCUMENT_TYPE.
 */
export const PO_VENDOR_CHANGE_WORKFLOW_SPEC: unknown = {
  documentType: 'po_vendor_change',
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: "Base route: an Accountant checks the new vendor's quotation",
    },
    {
      id: 'finance',
      kind: 'role',
      role: 'finance',
      reason: "Base route: Finance commits the budget for the changed vendor's order",
    },
  ],
  rules: [
    {
      id: 'management',
      when: { field: 'amountNpr', op: 'gt', value: '100000.00' },
      add: {
        id: 'management',
        kind: 'role',
        role: 'management',
        reason: "Management approval because the changed vendor's order exceeds NPR 100,000.00",
      },
      position: 'end',
      reason: "Changed vendor's order of NPR {amountNpr} is above NPR 100,000.00",
    },
    {
      id: 'founder',
      when: {
        all: [
          { field: 'amountNpr', op: 'gt', value: '1000000.00' },
          { field: 'requesterIsFounder', op: 'eq', value: false },
        ],
      },
      add: {
        id: 'founder',
        kind: 'role',
        role: 'founder',
        reason: "Founder approval because the changed vendor's order exceeds NPR 1,000,000.00",
      },
      position: 'end',
      reason: "Changed vendor's order of NPR {amountNpr} is above NPR 1,000,000.00",
    },
    {
      id: 'management_second',
      when: {
        all: [
          { field: 'amountNpr', op: 'gt', value: '1000000.00' },
          { field: 'requesterIsFounder', op: 'eq', value: true },
        ],
      },
      add: {
        id: 'management_second',
        kind: 'role',
        role: 'management',
        reason: 'A second Management approval replaces the Founder, who swapped the vendor (AD8)',
      },
      position: 'end',
      reason: "The Founder swapped this order's vendor to NPR {amountNpr}, above NPR 1,000,000.00",
    },
  ],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'management' } },
};

/**
 * Copy of VENDOR_BILL_WORKFLOW_SPEC (apps/api/src/modules/payables/bills/vendor-bill.rules.ts).
 * `documentType` is the literal of VENDOR_BILL_DOCUMENT_TYPE.
 */
export const VENDOR_BILL_WORKFLOW_SPEC: unknown = {
  documentType: 'vendor_bill',
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: 'Base route: an Accountant who did not enter the bill checks it',
    },
    {
      id: 'finance',
      kind: 'role',
      role: 'finance',
      reason: 'Base route: Finance accepts the payable',
    },
  ],
  rules: [
    {
      id: 'management',
      when: {
        all: [
          { field: 'poMatched', op: 'eq', value: false },
          { field: 'band', op: 'in', value: ['management', 'founder'] },
        ],
      },
      add: {
        id: 'management',
        kind: 'role',
        role: 'management',
        reason:
          'Management approval because a bill without a purchase order exceeds NPR 100,000.00',
      },
      position: 'end',
      reason: 'Non-PO bill of NPR {amountNpr} is above NPR 100,000.00',
    },
    {
      id: 'founder',
      when: {
        all: [
          { field: 'poMatched', op: 'eq', value: false },
          { field: 'band', op: 'eq', value: 'founder' },
        ],
      },
      add: {
        id: 'founder',
        kind: 'role',
        role: 'founder',
        reason: 'Founder approval because a bill without a purchase order exceeds NPR 1,000,000.00',
      },
      position: 'end',
      reason: 'Non-PO bill of NPR {amountNpr} is above NPR 1,000,000.00',
    },
  ],
};

/**
 * Copy of MATCH_EXCEPTION_WORKFLOW_SPEC (apps/api/src/modules/payables/bills/vendor-bill.rules.ts).
 * `documentType` is the literal of MATCH_EXCEPTION_DOCUMENT_TYPE.
 */
export const MATCH_EXCEPTION_WORKFLOW_SPEC: unknown = {
  documentType: 'match_exception',
  steps: [
    {
      id: 'finance',
      kind: 'role',
      role: 'finance',
      reason: 'Finance decides whether a bill outside the match tolerance may go to approval',
    },
  ],
  rules: [],
};

/**
 * Copy of PAYMENT_REQUEST_WORKFLOW_SPEC (apps/api/src/modules/payables/payment-requests/payment-request.rules.ts).
 * `documentType` is the literal of PAYMENT_REQUEST_DOCUMENT_TYPE.
 */
export const PAYMENT_REQUEST_WORKFLOW_SPEC: unknown = {
  documentType: 'payment_request',
  steps: [
    {
      id: 'finance',
      kind: 'role',
      role: 'finance',
      reason: 'Base route: Finance approves the payment',
    },
  ],
  rules: [
    {
      id: 'management',
      when: {
        all: [
          { field: 'allPoMatched', op: 'eq', value: false },
          { field: 'amountNpr', op: 'gt', value: '100000.00' },
        ],
      },
      add: {
        id: 'management',
        kind: 'role',
        role: 'management',
        reason: 'Management approval because a payment not fully PO-matched exceeds NPR 100,000.00',
      },
      position: 'end',
      reason: 'Payment of NPR {amountNpr} is above NPR 100,000.00',
    },
    {
      id: 'founder',
      when: {
        all: [
          { field: 'allPoMatched', op: 'eq', value: false },
          { field: 'amountNpr', op: 'gt', value: '1000000.00' },
          { field: 'requesterIsFounder', op: 'eq', value: false },
        ],
      },
      add: {
        id: 'founder',
        kind: 'role',
        role: 'founder',
        reason: 'Founder approval because a payment not fully PO-matched exceeds NPR 1,000,000.00',
      },
      position: 'end',
      reason: 'Payment of NPR {amountNpr} is above NPR 1,000,000.00',
    },
    {
      id: 'management_second',
      when: {
        all: [
          { field: 'allPoMatched', op: 'eq', value: false },
          { field: 'amountNpr', op: 'gt', value: '1000000.00' },
          { field: 'requesterIsFounder', op: 'eq', value: true },
        ],
      },
      add: {
        id: 'management_second',
        kind: 'role',
        role: 'management',
        reason: 'A second Management approval replaces the Founder, who raised this payment (AD8)',
      },
      position: 'end',
      reason: 'The Founder raised a payment of NPR {amountNpr}, above NPR 1,000,000.00',
    },
  ],
  distinctApprovers: true,
};

/**
 * Copy of EMERGENCY_REVIEW_WORKFLOW_SPEC (apps/api/src/modules/procurement/receipts/emergency-review.ts).
 */
export const EMERGENCY_REVIEW_WORKFLOW_SPEC: unknown = {
  documentType: 'emergency_review',
  steps: [
    {
      id: 'management',
      kind: 'role',
      role: 'management',
      reason: 'Management reviews an emergency purchase after it was received',
    },
  ],
  rules: [],
  distinctApprovers: true,
  sla: { remindAfterHours: 72, escalateAfterHours: 168, escalateTo: { role: 'founder' } },
};
