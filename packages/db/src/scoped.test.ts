import { eq } from 'drizzle-orm';
import { PgDialect, text, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { appSchema, organizations } from './schema/platform.js';
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

// A stand-in for a business document a portal shows (like test_memos): it has the owning organization AND both
// counterparty columns, so a wrong filter would have something to pick.
const portalDocs = appSchema.table('portal_docs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  customerOrganizationId: uuid('customer_organization_id'),
  vendorOrganizationId: uuid('vendor_organization_id'),
  title: text('title'),
});

describe('scoped().forCounterparty', () => {
  // The scope's organizationId is the principal's own organization (the customer or vendor org).
  it.each([
    ['customer', '"customer_organization_id"'],
    ['vendor', '"vendor_organization_id"'],
  ] as const)(
    'filters the %s column on the principal org and never on organization_id',
    (kind, column) => {
      const { sql, params } = dialect.sqlToQuery(scoped(scope).forCounterparty(portalDocs, kind));
      expect(sql).toContain('"tenant_id" = $1');
      expect(sql).toContain(`${column} = $2`);
      expect(params).toEqual([scope.tenantId, scope.organizationId]);
      // Remove the allowed column names; what remains must not mention organization_id at all. (Matching the
      // bare word would be fooled by "customer_organization_id", so the allowed names are cut out first.)
      const rest = sql
        .replaceAll('"customer_organization_id"', '')
        .replaceAll('"vendor_organization_id"', '');
      expect(rest).not.toContain('organization_id');
    },
  );

  it('keeps the extra condition and still adds tenant and counterparty', () => {
    const { sql, params } = dialect.sqlToQuery(
      scoped(scope).forCounterparty(portalDocs, 'customer', eq(portalDocs.title, 'Quote')),
    );
    expect(sql).toContain('"customer_organization_id" = $2');
    expect(sql).toContain('"title" = $3');
    expect(params).toEqual([scope.tenantId, scope.organizationId, 'Quote']);
  });

  it('throws when the table lacks the counterparty column', () => {
    // organizations has tenantId but no customerOrganizationId; the cast stands in for a JS caller.
    const table = organizations as unknown as typeof portalDocs;
    expect(() => scoped(scope).forCounterparty(table, 'customer')).toThrow(
      /customerOrganizationId/,
    );
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
