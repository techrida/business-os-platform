// The dev seed (tools/seed-zitadel) cannot import apps/api, so it holds word-for-word copies of the six
// workflow specs the API publishes (three procurement ones through ApprovalsAdminService, the two vendor
// bill ones and the payment request one). This test is the drift alarm: if either side changes alone, it fails. The copies live in a small
// import-free module of the tool.
import { WorkflowSpecSchema } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  EMERGENCY_REVIEW_WORKFLOW_SPEC as SEEDED_EMERGENCY_REVIEW_SPEC,
  MATCH_EXCEPTION_WORKFLOW_SPEC as SEEDED_MATCH_EXCEPTION_SPEC,
  PAYMENT_REQUEST_WORKFLOW_SPEC as SEEDED_PAYMENT_REQUEST_SPEC,
  PO_AMENDMENT_WORKFLOW_SPEC as SEEDED_PO_AMENDMENT_SPEC,
  PO_VENDOR_CHANGE_WORKFLOW_SPEC as SEEDED_PO_VENDOR_CHANGE_SPEC,
  PR_COMMITMENT_WORKFLOW_SPEC as SEEDED_PR_COMMITMENT_SPEC,
  PURCHASE_REQUEST_WORKFLOW_SPEC as SEEDED_PURCHASE_REQUEST_SPEC,
  VENDOR_BILL_WORKFLOW_SPEC as SEEDED_VENDOR_BILL_SPEC,
} from '../../../../../tools/seed-zitadel/src/workflow-specs';
import {
  MATCH_EXCEPTION_DOCUMENT_TYPE,
  MATCH_EXCEPTION_WORKFLOW_SPEC,
  VENDOR_BILL_DOCUMENT_TYPE,
  VENDOR_BILL_WORKFLOW_SPEC,
} from '../payables/bills/vendor-bill.rules';
import {
  PAYMENT_REQUEST_DOCUMENT_TYPE,
  PAYMENT_REQUEST_WORKFLOW_SPEC,
} from '../payables/payment-requests/payment-request.rules';
import {
  EMERGENCY_REVIEW_DOCUMENT_TYPE,
  EMERGENCY_REVIEW_WORKFLOW_SPEC,
} from './receipts/emergency-review';
import {
  PO_VENDOR_CHANGE_DOCUMENT_TYPE,
  PO_VENDOR_CHANGE_WORKFLOW_SPEC,
} from './orders/po-vendor-change.rules';
import {
  PO_AMENDMENT_DOCUMENT_TYPE,
  PO_AMENDMENT_WORKFLOW_SPEC,
} from './orders/purchase-order.rules';
import {
  PURCHASE_REQUEST_DOCUMENT_TYPE,
  PURCHASE_REQUEST_WORKFLOW_SPEC,
} from './requests/purchase-request.rules';
import {
  PR_COMMITMENT_DOCUMENT_TYPE,
  PR_COMMITMENT_WORKFLOW_SPEC,
} from './sourcing/sourcing.rules';

describe('seed workflow parity', () => {
  it('seeds purchase_request with exactly the spec the API publishes', () => {
    expect(SEEDED_PURCHASE_REQUEST_SPEC).toStrictEqual(PURCHASE_REQUEST_WORKFLOW_SPEC);
    // What the seed stores is the schema's defaulted form, so that form must match too.
    expect(WorkflowSpecSchema.parse(SEEDED_PURCHASE_REQUEST_SPEC)).toStrictEqual(
      WorkflowSpecSchema.parse(PURCHASE_REQUEST_WORKFLOW_SPEC),
    );
    expect(WorkflowSpecSchema.parse(SEEDED_PURCHASE_REQUEST_SPEC).documentType).toBe(
      PURCHASE_REQUEST_DOCUMENT_TYPE,
    );
  });

  it('seeds pr_commitment with exactly the spec the API publishes', () => {
    expect(SEEDED_PR_COMMITMENT_SPEC).toStrictEqual(PR_COMMITMENT_WORKFLOW_SPEC);
    expect(WorkflowSpecSchema.parse(SEEDED_PR_COMMITMENT_SPEC)).toStrictEqual(
      WorkflowSpecSchema.parse(PR_COMMITMENT_WORKFLOW_SPEC),
    );
    expect(WorkflowSpecSchema.parse(SEEDED_PR_COMMITMENT_SPEC).documentType).toBe(
      PR_COMMITMENT_DOCUMENT_TYPE,
    );
  });

  it('seeds po_amendment with exactly the spec the API publishes', () => {
    expect(SEEDED_PO_AMENDMENT_SPEC).toStrictEqual(PO_AMENDMENT_WORKFLOW_SPEC);
    expect(WorkflowSpecSchema.parse(SEEDED_PO_AMENDMENT_SPEC)).toStrictEqual(
      WorkflowSpecSchema.parse(PO_AMENDMENT_WORKFLOW_SPEC),
    );
    expect(WorkflowSpecSchema.parse(SEEDED_PO_AMENDMENT_SPEC).documentType).toBe(
      PO_AMENDMENT_DOCUMENT_TYPE,
    );
  });

  it('seeds po_vendor_change with exactly the spec the API publishes', () => {
    expect(SEEDED_PO_VENDOR_CHANGE_SPEC).toStrictEqual(PO_VENDOR_CHANGE_WORKFLOW_SPEC);
    expect(WorkflowSpecSchema.parse(SEEDED_PO_VENDOR_CHANGE_SPEC)).toStrictEqual(
      WorkflowSpecSchema.parse(PO_VENDOR_CHANGE_WORKFLOW_SPEC),
    );
    expect(WorkflowSpecSchema.parse(SEEDED_PO_VENDOR_CHANGE_SPEC).documentType).toBe(
      PO_VENDOR_CHANGE_DOCUMENT_TYPE,
    );
  });

  it('seeds emergency_review with exactly the spec the API publishes', () => {
    expect(SEEDED_EMERGENCY_REVIEW_SPEC).toStrictEqual(EMERGENCY_REVIEW_WORKFLOW_SPEC);
    expect(WorkflowSpecSchema.parse(SEEDED_EMERGENCY_REVIEW_SPEC).documentType).toBe(
      EMERGENCY_REVIEW_DOCUMENT_TYPE,
    );
  });

  it('seeds vendor_bill with exactly the spec the API publishes', () => {
    expect(SEEDED_VENDOR_BILL_SPEC).toStrictEqual(VENDOR_BILL_WORKFLOW_SPEC);
    expect(WorkflowSpecSchema.parse(SEEDED_VENDOR_BILL_SPEC)).toStrictEqual(
      WorkflowSpecSchema.parse(VENDOR_BILL_WORKFLOW_SPEC),
    );
    expect(WorkflowSpecSchema.parse(SEEDED_VENDOR_BILL_SPEC).documentType).toBe(
      VENDOR_BILL_DOCUMENT_TYPE,
    );
  });

  it('seeds match_exception with exactly the spec the API publishes', () => {
    expect(SEEDED_MATCH_EXCEPTION_SPEC).toStrictEqual(MATCH_EXCEPTION_WORKFLOW_SPEC);
    expect(WorkflowSpecSchema.parse(SEEDED_MATCH_EXCEPTION_SPEC)).toStrictEqual(
      WorkflowSpecSchema.parse(MATCH_EXCEPTION_WORKFLOW_SPEC),
    );
    expect(WorkflowSpecSchema.parse(SEEDED_MATCH_EXCEPTION_SPEC).documentType).toBe(
      MATCH_EXCEPTION_DOCUMENT_TYPE,
    );
  });

  it('seeds payment_request with exactly the spec the API publishes', () => {
    expect(SEEDED_PAYMENT_REQUEST_SPEC).toStrictEqual(PAYMENT_REQUEST_WORKFLOW_SPEC);
    expect(WorkflowSpecSchema.parse(SEEDED_PAYMENT_REQUEST_SPEC)).toStrictEqual(
      WorkflowSpecSchema.parse(PAYMENT_REQUEST_WORKFLOW_SPEC),
    );
    expect(WorkflowSpecSchema.parse(SEEDED_PAYMENT_REQUEST_SPEC).documentType).toBe(
      PAYMENT_REQUEST_DOCUMENT_TYPE,
    );
  });
});
