// Unit tests of the PUT merge rule and the capability rule; the database path is covered by
// drafting.integration.test.ts.
import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import type { Principal } from '../../../platform/authz/principal';
import { capabilitiesOf, mergeDraftPatch } from './drafting.service';

const saved = {
  currency: 'NPR',
  scope: 'Phase 1 and 2',
  contactId: '11111111-1111-4111-8111-111111111111',
  discount: { mode: 'pct', value: '8' },
  paymentSchedule: [{ label: 'All', percent: '100' }],
};

describe('mergeDraftPatch', () => {
  it('keeps every saved value the patch leaves out', () => {
    expect(mergeDraftPatch(saved, { scope: 'Phase 1 only' })).toEqual({
      ...saved,
      scope: 'Phase 1 only',
    });
  });

  it('clears a saved value the patch sets to null', () => {
    const merged = mergeDraftPatch(saved, { discount: null, contactId: null, scope: undefined });
    expect(merged).not.toHaveProperty('discount');
    expect(merged).not.toHaveProperty('contactId');
    expect(merged.scope).toBe('Phase 1 and 2');
  });

  it('sets, keeps and clears the terms and conditions like any other text field', () => {
    const withTerms = { ...saved, termsAndConditions: 'Payment within 30 days.' };
    expect(mergeDraftPatch(saved, { termsAndConditions: 'Net 30' }).termsAndConditions).toBe(
      'Net 30',
    );
    expect(mergeDraftPatch(withTerms, { scope: 'Phase 1 only' }).termsAndConditions).toBe(
      'Payment within 30 days.',
    );
    expect(mergeDraftPatch(withTerms, { termsAndConditions: null })).not.toHaveProperty(
      'termsAndConditions',
    );
  });

  it('replaces the schedule with an empty one', () => {
    expect(mergeDraftPatch(saved, { paymentSchedule: [] }).paymentSchedule).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------- capabilities

const TENANT = '00000000-0000-4000-8000-000000000001';
const ENTITY = '00000000-0000-4000-8000-000000000002';
const ME = '00000000-0000-4000-8000-000000000003';
const COLLEAGUE = '00000000-0000-4000-8000-000000000004';
const CUSTOMER = '00000000-0000-4000-8000-000000000005';

function principalOf(role: RoleKey, over: Partial<Principal> = {}): Principal {
  return {
    userId: ME,
    zitadelUserId: 'z-me',
    tenantId: TENANT,
    organizationId: ENTITY,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: '00000000-0000-4000-8000-000000000009',
    roles: [role],
    departmentId: null,
    status: 'active',
    grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>,
    ...over,
  };
}

const quotationOf = (ownerUserId: string | null) => ({
  tenantId: TENANT,
  organizationId: ENTITY,
  ownerUserId,
  customerPartyId: CUSTOMER,
});

describe('capabilitiesOf (the detail and list answer the same rules as the commands)', () => {
  it('lets the owner edit a Draft or a Returned version, and nothing else', () => {
    const sales = principalOf('sales');
    expect(capabilitiesOf(sales, quotationOf(ME), 'draft').canEdit).toBe(true);
    expect(capabilitiesOf(sales, quotationOf(ME), 'returned').canEdit).toBe(true);
    for (const status of ['submitted', 'approved', 'sent', 'rejected', 'expired'] as const) {
      expect(capabilitiesOf(sales, quotationOf(ME), status).canEdit, status).toBe(false);
    }
  });

  it("refuses edit and revise on a colleague's quotation under own scope", () => {
    const sales = principalOf('sales');
    expect(capabilitiesOf(sales, quotationOf(COLLEAGUE), 'returned')).toEqual({
      canEdit: false,
      canRevise: false,
      canSend: false,
      canRecordOutcome: false,
      canCancel: false,
    });
    expect(capabilitiesOf(sales, quotationOf(COLLEAGUE), 'approved').canRevise).toBe(false);
    expect(capabilitiesOf(sales, quotationOf(COLLEAGUE), 'approved').canSend).toBe(false);
    expect(capabilitiesOf(sales, quotationOf(COLLEAGUE), 'sent').canRecordOutcome).toBe(false);
  });

  it('offers revise only for a revisable status the caller may revise', () => {
    const sales = principalOf('sales');
    expect(capabilitiesOf(sales, quotationOf(ME), 'approved').canRevise).toBe(true);
    expect(capabilitiesOf(sales, quotationOf(ME), 'rejected').canRevise).toBe(true);
    expect(capabilitiesOf(sales, quotationOf(ME), 'draft').canRevise).toBe(false);
    // PMO drafts its own quotations but holds no quotation.revise: the button that answered 403.
    const pmo = principalOf('pmo');
    expect(capabilitiesOf(pmo, quotationOf(ME), 'approved').canRevise).toBe(false);
    expect(capabilitiesOf(pmo, quotationOf(ME), 'draft').canEdit).toBe(true);
  });

  it('offers send on approved/expired and record outcome on sent only with the live grant', () => {
    const sales = principalOf('sales');
    expect(capabilitiesOf(sales, quotationOf(ME), 'approved')).toEqual({
      canEdit: false,
      canRevise: true,
      canSend: true,
      canRecordOutcome: false,
      canCancel: false,
    });
    expect(capabilitiesOf(sales, quotationOf(ME), 'expired')).toEqual({
      canEdit: false,
      canRevise: true,
      canSend: true,
      canRecordOutcome: false,
      canCancel: false,
    });
    expect(capabilitiesOf(sales, quotationOf(ME), 'sent')).toEqual({
      canEdit: false,
      canRevise: true,
      canSend: false,
      canRecordOutcome: true,
      canCancel: false,
    });
    for (const status of [
      'draft',
      'submitted',
      'returned',
      'accepted',
      'rejected',
      'cancelled',
    ] as const) {
      expect(capabilitiesOf(sales, quotationOf(ME), status).canSend, status).toBe(false);
      expect(capabilitiesOf(sales, quotationOf(ME), status).canRecordOutcome, status).toBe(false);
    }

    const pmo = principalOf('pmo');
    expect(capabilitiesOf(pmo, quotationOf(ME), 'approved').canSend).toBe(false);
    expect(capabilitiesOf(pmo, quotationOf(ME), 'sent').canRecordOutcome).toBe(false);
  });

  it("offers the Accountant record outcome on a colleague's Sent quotation, and still no edit, send or revise (S4-Q2)", () => {
    const accountant = principalOf('accountant');
    expect(capabilitiesOf(accountant, quotationOf(COLLEAGUE), 'sent')).toEqual({
      canEdit: false,
      canRevise: false,
      canSend: false,
      canRecordOutcome: true,
      canCancel: false,
    });
    expect(capabilitiesOf(accountant, quotationOf(COLLEAGUE), 'approved').canSend).toBe(false);
    expect(capabilitiesOf(accountant, quotationOf(COLLEAGUE), 'draft').canEdit).toBe(false);
    // Another entity's quotation stays out of reach.
    expect(
      capabilitiesOf(accountant, { ...quotationOf(COLLEAGUE), organizationId: CUSTOMER }, 'sent')
        .canRecordOutcome,
    ).toBe(false);
  });

  it('offers cancel to whoever may edit the quotation, while it is a draft, returned or submitted (F1-Q27)', () => {
    const sales = principalOf('sales');
    for (const status of ['draft', 'returned', 'submitted'] as const) {
      expect(capabilitiesOf(sales, quotationOf(ME), status).canCancel, status).toBe(true);
      expect(capabilitiesOf(sales, quotationOf(COLLEAGUE), status).canCancel, status).toBe(false);
    }
    for (const status of [
      'approved',
      'sent',
      'accepted',
      'rejected',
      'expired',
      'cancelled',
      'superseded',
    ] as const) {
      expect(capabilitiesOf(sales, quotationOf(ME), status).canCancel, status).toBe(false);
    }
    expect(capabilitiesOf(principalOf('pmo'), quotationOf(ME), 'submitted').canCancel).toBe(true);
  });

  it('gives an inactive user nothing', () => {
    const inactive = principalOf('sales', { status: 'inactive' });
    expect(capabilitiesOf(inactive, quotationOf(ME), 'draft')).toEqual({
      canEdit: false,
      canRevise: false,
      canSend: false,
      canRecordOutcome: false,
      canCancel: false,
    });
    expect(capabilitiesOf(inactive, quotationOf(ME), 'approved').canRevise).toBe(false);
    expect(capabilitiesOf(inactive, quotationOf(ME), 'approved').canSend).toBe(false);
    expect(capabilitiesOf(inactive, quotationOf(ME), 'sent').canRecordOutcome).toBe(false);
  });
});
