import { eq } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { organizations } from './schema/platform.js';
import { scoped } from './scoped.js';

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
};
const dialect = new PgDialect();

describe('scoped().where', () => {
  it('always filters on both tenant_id and organization_id', () => {
    const { sql, params } = dialect.sqlToQuery(scoped(scope).where(organizations));
    expect(sql).toContain('"tenant_id" = $1');
    expect(sql).toContain('"organization_id" = $2');
    expect(params).toEqual([scope.tenantId, scope.organizationId]);
  });

  it('keeps the extra condition and still adds both ids', () => {
    const { sql, params } = dialect.sqlToQuery(
      scoped(scope).where(organizations, eq(organizations.name, 'Acme')),
    );
    expect(sql).toContain('"tenant_id" = $1');
    expect(sql).toContain('"organization_id" = $2');
    expect(sql).toContain('"name" = $3');
    expect(params).toEqual([scope.tenantId, scope.organizationId, 'Acme']);
  });

  it('refuses an empty id instead of building a filter that matches nothing', () => {
    expect(() => scoped({ ...scope, tenantId: '' })).toThrow(/non-empty/);
    expect(() => scoped({ ...scope, organizationId: '' })).toThrow(/non-empty/);
  });
});

describe('scoped().values', () => {
  it('adds both ids to a row that has neither', () => {
    expect(scoped(scope).values({ name: 'Acme' })).toEqual({ name: 'Acme', ...scope });
  });

  it('accepts a row that already carries the same ids', () => {
    expect(scoped(scope).values({ name: 'Acme', ...scope })).toEqual({ name: 'Acme', ...scope });
  });

  it('throws when the caller tries to write into another tenant or organization', () => {
    const s = scoped(scope);
    expect(() => s.values({ name: 'x', tenantId: 'other-tenant' })).toThrow(/tenantId/);
    expect(() => s.values({ name: 'x', organizationId: 'other-org' })).toThrow(/organizationId/);
  });

  it('does not mutate the row it was given', () => {
    const row = { name: 'Acme' };
    scoped(scope).values(row);
    expect(row).toEqual({ name: 'Acme' });
  });
});
