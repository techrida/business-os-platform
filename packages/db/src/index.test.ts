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

  it('gives organizations the documented fields', () => {
    expect(Object.keys(api.organizations)).toEqual(
      expect.arrayContaining(['id', 'tenantId', 'organizationId', 'kind', 'name', 'zitadelOrgId']),
    );
  });
});
