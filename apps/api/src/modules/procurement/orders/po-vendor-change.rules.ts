// Workflow spec for re-approving a draft purchase order vendor swap whose total differs (K3 Q1).
// Pure module (no I/O) so the service, subject, tests and seed parity check share one copy.

/** approval_requests.document_type of a re-approved draft PO vendor swap; the document id is the change's own id. */
export const PO_VENDOR_CHANGE_DOCUMENT_TYPE = 'po_vendor_change' as const;

/**
 * The workflow the seed unit publishes for `po_vendor_change` (v1). Same shape as the commitment route (AD10, AD4,
 * AD8): Accountant → Finance on the changed vendor's grand total incl. VAT in NPR; above 100,000.00 adds
 * Management, above 1,000,000.00 adds Founder, and a second, distinct Management step when the Founder requested
 * the vendor change. The one copy the tests and the hand-back quote; the seed copies it word for word.
 */
export const PO_VENDOR_CHANGE_WORKFLOW_SPEC: unknown = {
  documentType: PO_VENDOR_CHANGE_DOCUMENT_TYPE,
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
