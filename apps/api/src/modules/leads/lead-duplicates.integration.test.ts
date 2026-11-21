// Integration test of GET /v1/leads/duplicates (F1-Q54 a) on a real Postgres (shared test database, see
// test/harness.ts). Real: migrations, pg_trgm, LeadsService (to create the leads), LeadDuplicatesService and the
// controller behind the production setup. Faked: the request context and authz.assert (the real can()).
// The scope-leak cases are the point: a lead of another owner under an `own` read grant, a customer the caller does
// not own under an `own` customer read, and every record of another tenant must never appear, by id or by name.
// Run: pnpm --filter @bos/api exec vitest run src/modules/leads/lead-duplicates.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { CreateLeadBodySchema, LeadDuplicatesResponseSchema } from '@bos/contracts';
import { createParty, createTenantWithEntity, customerContacts, leads } from '@bos/db';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { systemActor, withTx } from '../../platform/db/tx';
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import { NumberingService } from '../../platform/settings/numbering.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { LeadDuplicatesController } from './lead-duplicates.controller';
import { LeadDuplicatesService } from './lead-duplicates.service';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadLostReasonsService } from './lost-reasons.service';
import { startHarness, type Harness } from './test/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const ADDRESS = JSON.stringify({ line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' });

let h: Harness;
let app: INestApplication;
let baseUrl: string;
let leadsService: LeadsService;

/** Ids and names seeded in the caller's tenant (A) and in another tenant. */
const seeded = {
  ownLead: '',
  colleagueLead: '',
  customerOfSalesA: '',
  customerOfSalesB: '',
  otherTenantLead: '',
  otherTenantCustomer: '',
};

/** A customer party plus its customers row (they belong to no entity; organizationId only scopes the write). */
async function customer(
  tenantId: string,
  organizationId: string,
  legalName: string,
  owner: string | null,
) {
  const { partyId } = await createParty(h.appPool as never, { tenantId, kind: 'customer' });
  await withTx(h.db, { tenantId, organizationId }, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address, owner_user_id)
          VALUES (${partyId}, ${tenantId}, ${`CUS-${partyId.slice(0, 13)}`}, ${legalName},
                  ${legalName.toLowerCase()}, ${ADDRESS}::jsonb, ${owner})`,
    ),
  );
  return partyId;
}

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  leadsService = new LeadsService(
    h.db,
    h.authz as unknown as AuthzService,
    new AuditService(h.db),
    new NumberingService(),
    h.caller,
    new CurrencyEnabledService(new SettingsService(h.db)),
    new LeadLostReasonsService(h.db, new AuditService(h.db), h.caller),
    h.roleCache,
    h.notify,
  );
  const moduleRef = await Test.createTestingModule({
    // Same order as LeadsModule: duplicates before LeadsController's GET ':id'.
    controllers: [LeadDuplicatesController, LeadsController],
    providers: [
      { provide: LeadsService, useValue: leadsService },
      { provide: LeadDuplicatesService, useValue: new LeadDuplicatesService(h.db, h.caller) },
    ],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  configureApp(app);
  app.useGlobalFilters(new ErrorBodyFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;

  // Through the contract schema, as the controller does, so its defaults apply.
  const lead = async (body: Record<string, string>) =>
    (
      await leadsService.create(
        CreateLeadBodySchema.parse({ title: 'Warehouse racks', source: 'referral', ...body }),
      )
    ).id;

  // salesA's own lead, and a colleague's (salesB) lead with the same email and phone.
  h.as('salesA', 'sales');
  seeded.ownLead = await lead({
    companyName: 'Himalayan Traders',
    contactName: 'Bikash Thapa',
    email: 'buyer@himalayan.example',
    phone: '+9779801112233',
  });
  // Six newer leads of salesA that share only the contact name: the cap must not push out the exact match above.
  for (let i = 0; i < 6; i += 1) {
    await lead({ companyName: `Unrelated Works ${i}`, contactName: 'Bikash Thapa' });
  }
  h.as('salesB', 'sales');
  seeded.colleagueLead = await lead({
    companyName: 'Himalayan Secretco',
    contactName: 'Hidden Colleague',
    email: 'buyer@himalayan.example',
    phone: '+9779801112233',
  });

  // Two customers of tenant A, one owned by each salesperson; the second has a contact with the same phone.
  seeded.customerOfSalesA = await customer(
    h.tenantId,
    h.scopeA.organizationId,
    'Himalayan Traders Pvt. Ltd.',
    h.users.salesA,
  );
  seeded.customerOfSalesB = await customer(
    h.tenantId,
    h.scopeA.organizationId,
    'Everest Hiddenmark Ltd.',
    h.users.salesB,
  );
  await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
    tx.insert(customerContacts).values({
      tenantId: h.tenantId,
      customerId: seeded.customerOfSalesB,
      fullName: 'Contact Of B',
      emailNorm: 'ops@everest.example',
      phoneE164: '+9779801112233',
    }),
  );

  // Another tenant with a lead and a customer that match every field.
  const other = await createTenantWithEntity(h.appPool as never);
  const otherScope = { tenantId: other.tenantId, organizationId: other.organizationId };
  seeded.otherTenantLead = randomUUID();
  await withTx(h.db, otherScope, systemActor('test'), (tx) =>
    tx.insert(leads).values({
      id: seeded.otherTenantLead,
      ...otherScope,
      number: 'LD-OTHER-1',
      title: 'Other tenant',
      source: 'referral',
      companyName: 'Himalayan Foreignco',
      contactName: 'Bikash Thapa',
      emailNorm: 'buyer@himalayan.example',
      phoneE164: '+9779801112233',
    }),
  );
  seeded.otherTenantCustomer = await customer(
    other.tenantId,
    other.organizationId,
    'Himalayan Foreignco Customer',
    null,
  );
});

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

beforeEach(() => {
  h.as('salesA', 'sales');
});

const lookup = async (query: Record<string, string>) => {
  const res = await request(baseUrl).get('/v1/leads/duplicates').query(query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { text: res.text, matches: LeadDuplicatesResponseSchema.parse(res.body).matches };
};

/** Nothing about an out-of-scope or foreign record: not its id, not its name. */
function expectNoLeak(text: string, also: string[] = []) {
  for (const id of [seeded.colleagueLead, seeded.otherTenantLead, seeded.otherTenantCustomer]) {
    expect(text).not.toContain(id);
  }
  for (const word of ['Secretco', 'Hidden Colleague', 'Foreignco', ...also]) {
    expect(text).not.toContain(word);
  }
}

describe('GET /v1/leads/duplicates', () => {
  it('finds the own lead by email (any case), phone (any format) and company, never a colleague’s', async () => {
    const byEmail = await lookup({ email: '  BUYER@Himalayan.example ' });
    const own = byEmail.matches.find((m) => m.id === seeded.ownLead);
    expect(own).toMatchObject({ kind: 'lead', matchedOn: ['email'] });
    expect(own?.label).toContain('Himalayan Traders');
    expectNoLeak(byEmail.text);

    const byPhone = await lookup({ phone: '980-111 2233' });
    expect(byPhone.matches.map((m) => m.id)).toContain(seeded.ownLead);
    // salesA reads every customer, so the contact's phone finds the customer salesB owns.
    expect(byPhone.matches).toContainEqual({
      kind: 'customer',
      id: seeded.customerOfSalesB,
      label: 'Everest Hiddenmark Ltd.',
      matchedOn: ['phone'],
    });
    expectNoLeak(byPhone.text);

    const byCompany = await lookup({ company: 'Himalayan' });
    const ids = byCompany.matches.map((m) => m.id);
    expect(ids).toContain(seeded.ownLead);
    expect(ids).toContain(seeded.customerOfSalesA);
    expectNoLeak(byCompany.text);
  });

  it('matches a misspelt company by trigram similarity', async () => {
    const { matches, text } = await lookup({ company: 'Himalyan Traders' });
    expect(matches.map((m) => m.id)).toEqual(
      expect.arrayContaining([seeded.ownLead, seeded.customerOfSalesA]),
    );
    expectNoLeak(text);
  });

  it('drops a customer the caller does not own under an own customer read (Marketing)', async () => {
    h.as('salesA', 'marketing');
    const { matches, text } = await lookup({ phone: '+977 9801112233', company: 'Himalayan' });
    const ids = matches.map((m) => m.id);
    expect(ids).toContain(seeded.ownLead);
    expect(ids).toContain(seeded.customerOfSalesA);
    expect(ids).not.toContain(seeded.customerOfSalesB);
    expectNoLeak(text, ['Everest', 'Hiddenmark', seeded.customerOfSalesB]);
  });

  it('leaves out a kind the caller cannot read at all', async () => {
    h.as('salesA', 'sales');
    const { matches } = await lookup({ company: 'Himalayan' });
    expect(matches.some((m) => m.kind === 'customer')).toBe(true);
    // A grant set without customer.read: only leads come back.
    const original = h.caller.current;
    h.caller.current = () => {
      const c = original();
      const grants = new Map(c.principal.grants);
      grants.delete('customer.read');
      return { ...c, principal: { ...c.principal, grants } };
    };
    try {
      const leadsOnly = await lookup({ company: 'Himalayan' });
      expect(leadsOnly.matches.length).toBeGreaterThan(0);
      expect(leadsOnly.matches.every((m) => m.kind === 'lead')).toBe(true);
    } finally {
      h.caller.current = original;
    }
  });

  it('ranks an exact email above newer leads with only a similar name, and returns at most 5', async () => {
    const { matches, text } = await lookup({
      name: 'Bikash Thapa',
      email: 'buyer@himalayan.example',
    });
    expect(matches).toHaveLength(5);
    expect(matches[0]).toMatchObject({ id: seeded.ownLead, matchedOn: ['name', 'email'] });
    expectNoLeak(text);
  });

  it('answers nothing for fields that are too short, and caps the answer at 5', async () => {
    expect((await lookup({ company: 'Hi', email: 'b@', phone: '98011' })).matches).toEqual([]);
    expect((await lookup({})).matches).toEqual([]);
    h.as('boss', 'founder');
    const { matches } = await lookup({ company: 'Himalayan', phone: '9801112233' });
    expect(matches.length).toBeLessThanOrEqual(5);
    // The founder reads every lead of the entity, but never another tenant's.
    expect(matches.map((m) => m.id)).toContain(seeded.colleagueLead);
    expect(JSON.stringify(matches)).not.toContain('Foreignco');
  });

  it('refuses an unknown query parameter with 400', async () => {
    const res = await request(baseUrl).get('/v1/leads/duplicates').query({ owner: 'x' });
    expect(res.status).toBe(400);
  });

  // Last on purpose: its 25 extra 'Himalayan A..' customers would crowd the earlier company lookups of the
  // all-scope Sales role out of the 5-match answer.
  it('does not let unreadable customers take the candidate slots of an own-scope reader (Marketing)', async () => {
    const hidden: string[] = [];
    for (let i = 1; i <= 25; i += 1) {
      hidden.push(
        await customer(
          h.tenantId,
          h.scopeA.organizationId,
          `Himalayan A${String(i).padStart(2, '0')}`,
          h.users.salesB,
        ),
      );
    }
    const zeta = await customer(
      h.tenantId,
      h.scopeA.organizationId,
      'Himalayan Zeta',
      h.users.salesA,
    );
    h.as('salesA', 'marketing');
    const { matches, text } = await lookup({ company: 'Himalayan' });
    const ids = matches.map((m) => m.id);
    expect(ids).toContain(zeta);
    expect(ids).toContain(seeded.customerOfSalesA);
    expectNoLeak(text, ['Himalayan A', ...hidden]);

    // An exact (case-insensitive) company name ranks first among the customers.
    const exact = await lookup({ company: 'himalayan zeta' });
    expect(exact.matches.filter((m) => m.kind === 'customer')[0]?.id).toBe(zeta);
    expectNoLeak(exact.text, ['Himalayan A', ...hidden]);
  });
});
