import { VENDOR_STATUSES, canTransitionVendor, type VendorStatus } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { grantsFrom } from '@/components/p2/customers/permissions';
import type { Grants } from '@/lib/grants';

import {
  identityLocked,
  isEditable,
  lifecycleOptions,
  mayGrantPortal,
  sendForReviewHint,
  VENDOR_KIND_LABEL,
  VENDOR_STATUS_LABEL,
  vendorGrants,
} from './model';

describe('vendor status and kind labels', () => {
  it('has a label for every status', () => {
    for (const s of VENDOR_STATUSES) expect(VENDOR_STATUS_LABEL[s].text.length).toBeGreaterThan(0);
  });
  it('words the kinds for a person', () => {
    expect(VENDOR_KIND_LABEL.sole_proprietor).toBe('Sole proprietor');
    expect(VENDOR_KIND_LABEL.foreign).toBe('Foreign vendor');
  });
});

describe('what can be edited', () => {
  it('a blocked or archived vendor cannot be edited', () => {
    expect(isEditable('blocked')).toBe(false);
    expect(isEditable('archived')).toBe(false);
    expect(isEditable('draft')).toBe(true);
    expect(isEditable('approved')).toBe(true);
  });
  it('the legal name and PAN lock once approved or suspended', () => {
    expect(identityLocked('approved')).toBe(true);
    expect(identityLocked('suspended')).toBe(true);
    expect(identityLocked('pending_kyc')).toBe(false);
  });
});

describe('lifecycle options', () => {
  const names = (status: VendorStatus, write: boolean, activate: boolean) =>
    lifecycleOptions(status, { write, activate }).map((o) => o.command);

  it('a draft can start KYB review, for writers only', () => {
    expect(names('draft', true, false)).toEqual(['submit_kyc']);
    expect(names('draft', false, true)).toEqual([]);
  });
  it('pending_kyc can be sent for review only once the KYB case is submitted', () => {
    const pending = (kybSubmitted: boolean | undefined, write = true) =>
      lifecycleOptions('pending_kyc', { write, activate: true }, kybSubmitted).map((o) => o.label);
    expect(pending(true)).toEqual(['Send for review']);
    expect(pending(false)).toEqual([]);
    // Unknown fails closed: the button would be refused by the API.
    expect(pending(undefined)).toEqual([]);
    expect(pending(true, false)).toEqual([]);
  });
  it('explains a missing "Send for review" to a writer, and only then', () => {
    expect(sendForReviewHint('pending_kyc', true, false)).toMatch(/once its KYB case is submitted/);
    expect(sendForReviewHint('pending_kyc', true, undefined)).toMatch(
      /could not check the KYB case/,
    );
    expect(sendForReviewHint('pending_kyc', true, true)).toBeNull();
    expect(sendForReviewHint('pending_kyc', false, false)).toBeNull();
    expect(sendForReviewHint('draft', true, false)).toBeNull();
  });
  it('under review can be activated only with vendor.activate', () => {
    expect(names('under_review', true, true)).toEqual(['activate']);
    expect(names('under_review', true, false)).toEqual([]);
  });
  it('approved can be suspended or blocked, with a reason', () => {
    const o = lifecycleOptions('approved', { write: false, activate: true });
    expect(o.map((x) => x.command)).toEqual(['suspend', 'block']);
    expect(o.every((x) => x.needsReason)).toBe(true);
  });
  it('suspended can be reinstated or blocked; blocked can be archived; archived has nothing', () => {
    expect(names('suspended', false, true)).toEqual(['activate', 'block']);
    expect(names('blocked', false, true)).toEqual(['archive']);
    expect(names('archived', true, true)).toEqual([]);
  });
  it('never offers a move the contract state machine forbids', () => {
    const to = {
      submit_kyc: 'pending_kyc',
      activate: 'approved',
      suspend: 'suspended',
      block: 'blocked',
      archive: 'archived',
    } as const;
    for (const s of VENDOR_STATUSES) {
      for (const o of lifecycleOptions(s, { write: true, activate: true }, true)) {
        if (o.command === 'submit_kyc') continue;
        expect(canTransitionVendor(s, to[o.command])).toBe(true);
      }
    }
  });
});

describe('portal access', () => {
  it('is offered for approved and pending_kyc vendors only, to writers', () => {
    expect(mayGrantPortal('approved', true)).toBe(true);
    expect(mayGrantPortal('pending_kyc', true)).toBe(true);
    expect(mayGrantPortal('draft', true)).toBe(false);
    expect(mayGrantPortal('suspended', true)).toBe(false);
    expect(mayGrantPortal('approved', false)).toBe(false);
  });
});

describe('vendorGrants', () => {
  it('reads the default grants of the session roles, denying by default', () => {
    const g = vendorGrants(['procurement']);
    expect(g.read).toBe(true);
    expect(g.write).toBe(true);
    expect(g.propose).toBe(true);
    expect(g.activate).toBe(false);
    expect(g.verify).toBe(false);
    const none = vendorGrants(['no_such_role']);
    expect(Object.values(none).every((v) => v === false)).toBe(true);
  });

  // The live saved grants decide, not the role defaults: an admin edits them in Settings > Access.
  it('follows a grant an admin added that no default carries (procurement defaults lack activate)', () => {
    const live: Grants = new Map([
      ['vendor.read', 'all'],
      ['vendor.activate', 'all'],
      ['vendor.bank.verify', 'all'],
    ]);
    expect(vendorGrants(live)).toEqual({
      read: true,
      write: false,
      activate: true,
      propose: false,
      verify: true,
    });
  });

  it('drops a grant an admin removed though the defaults still carry it', () => {
    const live = grantsFrom({ permissions: [{ permission: 'vendor.read', scope: 'all' }] }, [
      'procurement',
    ]);
    const g = vendorGrants(live);
    expect(g.read).toBe(true);
    expect(g.write).toBe(false);
    expect(g.propose).toBe(false);
    expect(Object.values(vendorGrants(new Map())).every((v) => v === false)).toBe(true);
  });
});
