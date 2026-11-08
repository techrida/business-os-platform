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

describe('P2 roles', () => {
  it.each(['pmo', 'operations_head', 'procurement', 'receiver'])('knows the role %s', (role) => {
    expect(RoleKeySchema.safeParse(role).success).toBe(true);
    expect(ROLE_KEYS).toContain(role);
    expect(DEFAULT_ROLE_PERMISSIONS).toHaveProperty(role);
  });

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

  it('lets management and the finance roles read all but never send, accept or revise', () => {
    const { management, finance, accountant } = DEFAULT_ROLE_PERMISSIONS;
    for (const role of [management, finance, accountant]) {
      for (const p of [
        'crm.lead.read',
        'crm.opportunity.read',
        'customer.read',
        'quotation.read',
        'verification.read',
      ] as const) {
        expect(role[p], p).toBe('all');
      }
      for (const p of [
        'crm.opportunity.write',
        'customer.write',
        'customer.merge',
        'quotation.send',
        'quotation.record_acceptance',
        'quotation.revise',
        'verification.review',
      ] as const) {
        expect(role[p], p).toBeUndefined();
      }
    }
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
    for (const p of [
      'crm.opportunity.read',
      'customer.read',
      'quotation.read',
      'verification.read',
    ] as const) {
      expect(grants[p], p).toBe('all');
    }
    for (const p of NEW_PERMISSIONS.filter((x) => !x.endsWith('.read'))) {
      expect(grants[p], p).toBeUndefined();
    }
  });

  it('gives procurement and receiver nothing from CRM or quotations', () => {
    for (const role of [DEFAULT_ROLE_PERMISSIONS.procurement, DEFAULT_ROLE_PERMISSIONS.receiver]) {
      for (const p of NEW_PERMISSIONS) expect(role[p], p).toBeUndefined();
    }
  });

  it('keeps vendor_user empty', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.vendor_user).toEqual({});
  });

  it('gives customer_user only the two portal quotation grants, at its own company', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.customer_user).toEqual({
      'portal.quotation.read': 'customer_org',
      'portal.quotation.respond': 'customer_org',
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
