import { eq } from 'drizzle-orm';
import { PgDialect, pgSchema, text, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { scoped } from './scoped.js';

const scope = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
};
const partyId = '33333333-3333-4333-8333-333333333333';
const dialect = new PgDialect();

// Fixture tables, declared here rather than imported from schema/, so these tests do not depend on the real
// schema while it changes.
const app = pgSchema('app');

/** An entity-owned table with no counterparty column. */
const entityDocs = app.table('entity_docs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  name: text('name'),
});

// A stand-in for a business document a portal shows (like test_memos): it has the issuing entity AND both
// counterparty columns (ADR 0027 §5), so a wrong filter would have something to pick.
const portalDocs = app.table('portal_docs', {
  id: uuid('id').primaryKey(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  customerPartyId: uuid('customer_party_id'),
  vendorPartyId: uuid('vendor_party_id'),
  title: text('title'),
});

describe('scoped().where', () => {
  it('always filters on both tenant_id and organization_id', () => {
    const { sql, params } = dialect.sqlToQuery(scoped(scope).where(entityDocs));
    expect(sql).toContain('"tenant_id" = $1');
    expect(sql).toContain('"organization_id" = $2');
    expect(params).toEqual([scope.tenantId, scope.organizationId]);
  });

  it('keeps the extra condition and still adds both ids', () => {
    const { sql, params } = dialect.sqlToQuery(
      scoped(scope).where(entityDocs, eq(entityDocs.name, 'Acme')),
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

describe('scoped().forCounterparty', () => {
  // The scope's organizationId is the acting entity; partyId is the portal principal's party.
  it.each([
    ['customer', '"customer_party_id"', '"vendor_party_id"'],
    ['vendor', '"vendor_party_id"', '"customer_party_id"'],
  ] as const)(
    'filters the %s column on the party, and on the tenant and the acting entity',
    (kind, column, otherColumn) => {
      const { sql, params } = dialect.sqlToQuery(
        scoped(scope).forCounterparty(portalDocs, kind, partyId),
      );
      expect(sql).toContain('"tenant_id" = $1');
      expect(sql).toContain('"organization_id" = $2');
      expect(sql).toContain(`${column} = $3`);
      expect(sql).not.toContain(otherColumn);
      expect(params).toEqual([scope.tenantId, scope.organizationId, partyId]);
    },
  );

  it('keeps the extra condition and still adds tenant, entity and party', () => {
    const { sql, params } = dialect.sqlToQuery(
      scoped(scope).forCounterparty(portalDocs, 'customer', partyId, eq(portalDocs.title, 'Quote')),
    );
    expect(sql).toContain('"customer_party_id" = $3');
    expect(sql).toContain('"title" = $4');
    expect(params).toEqual([scope.tenantId, scope.organizationId, partyId, 'Quote']);
  });

  it('refuses an empty partyId instead of building a filter that matches nothing', () => {
    expect(() => scoped(scope).forCounterparty(portalDocs, 'vendor', '')).toThrow(/partyId/);
  });

  it('throws when the table lacks the counterparty column', () => {
    // entityDocs has tenantId and organizationId but no customerPartyId; the cast stands in for a JS caller.
    const table = entityDocs as unknown as typeof portalDocs;
    expect(() => scoped(scope).forCounterparty(table, 'customer', partyId)).toThrow(
      /customerPartyId/,
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
