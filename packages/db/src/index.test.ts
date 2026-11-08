import { describe, expect, it } from 'vitest';

import * as api from './index.js';

// Other units (apps/api, tools/seed-zitadel) import these names; renaming one is a breaking change.
describe('@bos/db public API', () => {
  it('exports the tables, schema, migrate, scoped and the tenancy check', () => {
    expect(api.tenants).toBeDefined();
    expect(api.organizations).toBeDefined();
    expect(api.schema.organizations).toBe(api.organizations);
    expect(api.schema.tenants).toBe(api.tenants);
    expect(api.migrate).toBe(api.runMigrations);
    expect(typeof api.scoped).toBe('function');
    expect(typeof api.createDb).toBe('function');
    expect(typeof api.checkTenancy).toBe('function');
  });

  it('gives organizations the documented fields (a legal entity, ADR 0027)', () => {
    expect(Object.keys(api.organizations)).toEqual(
      expect.arrayContaining([
        'id',
        'tenantId',
        'organizationId',
        'code',
        'name',
        'legalName',
        'isDefault',
      ]),
    );
    // kind and zitadelOrgId moved to parties and idp_orgs.
    expect(Object.keys(api.organizations)).not.toContain('kind');
    expect(Object.keys(api.organizations)).not.toContain('zitadelOrgId');
  });

  it('exports the party and IdP org tables and the test fixtures', () => {
    expect(api.parties).toBeDefined();
    expect(api.idpOrgs).toBeDefined();
    expect(api.schema.parties).toBe(api.parties);
    expect(api.schema.idpOrgs).toBe(api.idpOrgs);
    expect(typeof api.createTenantWithEntity).toBe('function');
    expect(typeof api.createParty).toBe('function');
    expect(typeof api.createStaffUser).toBe('function');
    expect(typeof api.createPortalUser).toBe('function');
    expect(typeof api.createDepartment).toBe('function');
  });
});
