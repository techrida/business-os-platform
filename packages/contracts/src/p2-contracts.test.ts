import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  ROLE_KEYS,
  RoleKeySchema,
  type Permission,
} from './index.js';

const NEW_PERMISSIONS: readonly Permission[] = [
  'crm.lead.read',
  'crm.lead.write',
  'crm.opportunity.read',
  'crm.opportunity.write',
  'customer.read',
  'customer.write',
  'customer.merge',
  'quotation.read',
  'quotation.draft',
  'quotation.submit',
  'quotation.send',
  'quotation.record_acceptance',
  'quotation.revise',
  'verification.read',
  'verification.review',
];

describe('quotation.cost.read (D29a)', () => {
  it('is listed once and held by founder at scope all', () => {
    expect(PERMISSIONS.filter((p) => p === 'quotation.cost.read')).toHaveLength(1);
    expect(DEFAULT_ROLE_PERMISSIONS.founder['quotation.cost.read']).toBe('all');
  });

  it('goes to exactly the roles that draft or approve quotations', () => {
    const holders = ROLE_KEYS.filter(
      (role) => DEFAULT_ROLE_PERMISSIONS[role]['quotation.cost.read'] === 'all',
    );
    expect([...holders].sort()).toEqual(
      ['accountant', 'finance', 'founder', 'management', 'pmo', 'sales'].sort(),
    );
    // Migration 0055 uses the same rule on existing role_permissions rows.
    for (const role of ROLE_KEYS) {
      const grants = DEFAULT_ROLE_PERMISSIONS[role];
      const drafts = grants['quotation.draft'] !== undefined;
      const approves = grants['approvals.requests.act'] !== undefined;
      if (drafts || approves) expect(grants['quotation.cost.read'], role).toBe('all');
    }
  });

  it('is withheld from operations head, procurement, warehouse and the portal roles', () => {
    for (const role of [
      'operations_head',
      'procurement',
      'warehouse',
      'operations_officer',
      'customer_user',
      'vendor_user',
    ] as const) {
      expect(DEFAULT_ROLE_PERMISSIONS[role]['quotation.cost.read'], role).toBeUndefined();
    }
  });
});

describe('P2 roles', () => {
  it.each(['pmo', 'operations_head', 'procurement', 'warehouse', 'operations_officer'])(
    'knows the role %s',
    (role) => {
      expect(RoleKeySchema.safeParse(role).success).toBe(true);
      expect(ROLE_KEYS).toContain(role);
      expect(DEFAULT_ROLE_PERMISSIONS).toHaveProperty(role);
    },
  );

  it('keeps the P1 roles', () => {
    for (const role of ['founder', 'management', 'finance', 'accountant', 'sales']) {
      expect(ROLE_KEYS).toContain(role);
    }
  });
});

describe('P2 permissions', () => {
  it.each(NEW_PERMISSIONS)('lists %s once', (permission) => {
    expect(PERMISSIONS.filter((p) => p === permission)).toHaveLength(1);
  });

  it('has no duplicates and no wildcard', () => {
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
    for (const p of PERMISSIONS) expect(p).not.toContain('*');
  });

  it('gives founder every new permission at scope all', () => {
    for (const p of NEW_PERMISSIONS) expect(DEFAULT_ROLE_PERMISSIONS.founder[p]).toBe('all');
  });

  it('lets sales draft, submit, send, accept and revise only their own quotations', () => {
    const { sales } = DEFAULT_ROLE_PERMISSIONS;
    for (const p of [
      'quotation.read',
      'quotation.draft',
      'quotation.submit',
      'quotation.send',
      'quotation.record_acceptance',
      'quotation.revise',
      'crm.lead.read',
      'crm.lead.write',
      'crm.opportunity.read',
      'crm.opportunity.write',
    ] as const) {
      expect(sales[p], p).toBe('own');
    }
    expect(sales['customer.read']).toBe('all');
    expect(sales['customer.write']).toBe('all');
    expect(sales['customer.merge']).toBeUndefined();
    expect(sales['verification.review']).toBeUndefined();
  });

  it('lets management and the finance roles read all but never send or revise; only the Accountant records acceptance', () => {
    const { management, finance, accountant } = DEFAULT_ROLE_PERMISSIONS;
    for (const role of [management, finance, accountant]) {
      // Management, Finance and Accountant read all leads and opportunities (U20a2-Q4, Kuu 2026-11-20).
      for (const p of ['crm.lead.read', 'crm.opportunity.read'] as const) {
        expect(role[p], p).toBe('all');
      }
      for (const p of ['customer.read', 'quotation.read', 'verification.read'] as const) {
        expect(role[p], p).toBe('all');
      }
      for (const p of [
        'crm.opportunity.write',
        'customer.write',
        'customer.merge',
        'quotation.send',
        'quotation.revise',
        'verification.review',
      ] as const) {
        expect(role[p], p).toBeUndefined();
      }
    }
    // S4-Q2 (Kuu, 2026-11-21): the Accountant confirms a portal acceptance's evidence, across the entity.
    expect(accountant['quotation.record_acceptance']).toBe('all');
    expect(management['quotation.record_acceptance']).toBeUndefined();
    expect(finance['quotation.record_acceptance']).toBeUndefined();
    expect(management['crm.lead.write']).toBeUndefined();
    expect(management['quotation.draft']).toBeUndefined();
    expect(management['quotation.submit']).toBeUndefined();
  });

  it('lets finance and accountant create leads and draft and submit their own quotations (R1, C14)', () => {
    for (const role of [DEFAULT_ROLE_PERMISSIONS.finance, DEFAULT_ROLE_PERMISSIONS.accountant]) {
      expect(role['crm.lead.write']).toBe('own');
      expect(role['quotation.draft']).toBe('own');
      expect(role['quotation.submit']).toBe('own');
    }
  });

  it('lets PMO draft and submit, read all quotations, and review verification cases', () => {
    const { pmo } = DEFAULT_ROLE_PERMISSIONS;
    expect(pmo['crm.lead.write']).toBe('own');
    expect(pmo['quotation.draft']).toBe('own');
    expect(pmo['quotation.submit']).toBe('own');
    expect(pmo['quotation.read']).toBe('all');
    expect(pmo['verification.review']).toBe('all');
    expect(pmo['quotation.send']).toBeUndefined();
  });

  it('lets operations head read CRM, quotations and verification but not change them', () => {
    const grants = DEFAULT_ROLE_PERMISSIONS.operations_head;
    for (const p of ['customer.read', 'quotation.read', 'verification.read'] as const) {
      expect(grants[p], p).toBe('all');
    }
    // D50: Operations Head has no lead or opportunity access.
    expect(grants['crm.lead.read']).toBeUndefined();
    expect(grants['crm.opportunity.read']).toBeUndefined();
    for (const p of NEW_PERMISSIONS.filter((x) => !x.endsWith('.read'))) {
      expect(grants[p], p).toBeUndefined();
    }
  });

  it('gives procurement and warehouse nothing from CRM or quotations', () => {
    for (const role of [DEFAULT_ROLE_PERMISSIONS.procurement, DEFAULT_ROLE_PERMISSIONS.warehouse]) {
      for (const p of NEW_PERMISSIONS) {
        // P4 K3b: procurement reads KYB cases, because it opens and submits the vendor ones.
        if (role === DEFAULT_ROLE_PERMISSIONS.procurement && p === 'verification.read') continue;
        expect(role[p], p).toBeUndefined();
      }
    }
  });

  it('lets procurement read KYB cases but never review them (P4 K3b)', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.procurement['verification.read']).toBe('all');
    expect(DEFAULT_ROLE_PERMISSIONS.procurement['verification.review']).toBeUndefined();
    expect(DEFAULT_ROLE_PERMISSIONS.procurement['customer.write']).toBeUndefined();
  });

  it('keeps vendor_user to the two vendor-portal grants', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.vendor_user).toEqual({
      'portal.vendor.read': 'customer_org',
      'portal.vendor.submit': 'customer_org',
    });
  });

  it('gives customer_user only portal grants, at its own company (P3 adds the invoice and payment ones)', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.customer_user).toEqual({
      'portal.quotation.read': 'customer_org',
      'portal.quotation.respond': 'customer_org',
      'portal.invoice.read': 'customer_org',
      'portal.payment.submit': 'customer_org',
    });
  });

  it.each(['portal.quotation.read', 'portal.quotation.respond'] as const)(
    'lists %s once, gives founder all, and gives no other role a portal grant',
    (permission) => {
      expect(PERMISSIONS.filter((p) => p === permission)).toHaveLength(1);
      expect(DEFAULT_ROLE_PERMISSIONS.founder[permission]).toBe('all');
      for (const [role, grants] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
        if (role !== 'founder' && role !== 'customer_user') {
          expect(grants[permission], role).toBeUndefined();
        }
      }
    },
  );

  it('only founder holds customer.merge', () => {
    for (const [role, grants] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      if (role !== 'founder') expect(grants['customer.merge'], role).toBeUndefined();
    }
  });
});
