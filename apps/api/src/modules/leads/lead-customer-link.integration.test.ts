// Integration test of the customer link on a new lead (R6O, BOS-UI-002) on a real Postgres (see test/harness.ts).
// Real: migrations, LeadsService, the contract schema and the controller behind the production setup. Faked: the
// request context and authz.assert (the real can()).
// The point: picking a customer in the company field LINKS it (and one of its contacts), and the link is refused for a
// customer the caller may not read, one of another tenant, one that does not exist and a contact of another customer.
// Run: pnpm --filter @bos/api exec vitest run src/modules/leads/lead-customer-link.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ErrorBodySchema, LeadDtoSchema } from '@bos/contracts';
import { createParty, createTenantWithEntity, customerContacts } from '@bos/db';
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
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadLostReasonsService } from './lost-reasons.service';
import { startHarness, type Harness } from './test/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let h: Harness;
let app: INestApplication;
let baseUrl: string;

const seeded = {
  /** Owned by salesA. */
  ownCustomer: '',
  ownContact: '',
  /** Owned by salesB: salesA (role sales, all customers) reads it, marketing (own) does not. */
  colleagueCustomer: '',
  colleagueContact: '',
  otherTenantCustomer: '',
};

async function customer(
  tenantId: string,
  organizationId: string,
  legalName: string,
  owner: string | null,
) {
  const { partyId } = await createParty(h.appPool as never, { tenantId, kind: 'customer' });
  await withTx(h.db, { tenantId, organizationId }, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.customers
            (id, tenant_id, number, legal_name, name_norm, country, address_line, address_city, owner_user_id)
          VALUES (${partyId}, ${tenantId}, ${`CUS-${partyId.slice(0, 13)}`}, ${legalName},
                  ${legalName.toLowerCase()}, 'NP', '1 Durbar Marg', 'Kathmandu', ${owner})`,
    ),
  );
  return partyId;
}

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  const service = new LeadsService(
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
    controllers: [LeadsController],
    providers: [{ provide: LeadsService, useValue: service }],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  configureApp(app);
  app.useGlobalFilters(new ErrorBodyFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;

  seeded.ownCustomer = await customer(
    h.tenantId,
    h.scopeA.organizationId,
    'Own Traders Pvt. Ltd.',
    h.users.salesA,
  );
  seeded.colleagueCustomer = await customer(
    h.tenantId,
    h.scopeA.organizationId,
    'Colleague Traders Pvt. Ltd.',
    h.users.salesB,
  );
  await withTx(h.db, h.scopeA, systemActor('test'), async (tx) => {
    const rows = await tx
      .insert(customerContacts)
      .values([
        {
          tenantId: h.tenantId,
          customerId: seeded.ownCustomer,
          fullName: 'Asha Rai',
          emailNorm: 'asha@own.example',
        },
        {
          tenantId: h.tenantId,
          customerId: seeded.colleagueCustomer,
          fullName: 'Binod Karki',
          emailNorm: 'binod@colleague.example',
        },
      ])
      .returning({ id: customerContacts.id });
    seeded.ownContact = rows[0]!.id;
    seeded.colleagueContact = rows[1]!.id;
  });
  const other = await createTenantWithEntity(h.appPool as never);
  seeded.otherTenantCustomer = await customer(
    other.tenantId,
    other.organizationId,
    'Foreign Traders',
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

const BODY = {
  title: 'Racks for Own Traders',
  source: 'referral',
  companyName: 'Own Traders Pvt. Ltd.',
  contactName: 'Asha Rai',
  country: 'NP',
  email: 'asha@own.example',
};
const post = (extra: Record<string, unknown> = {}) =>
  request(baseUrl)
    .post('/v1/leads')
    .send({ ...BODY, ...extra });
const get = (id: string) => request(baseUrl).get(`/v1/leads/${id}`);
const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;

describe('POST /v1/leads with a linked customer (R6O)', () => {
  it('links a readable customer and one of its contacts, and a read shows the link', async () => {
    const res = await post({ customerId: seeded.ownCustomer, contactId: seeded.ownContact });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const created = LeadDtoSchema.parse(res.body);
    expect(created).toMatchObject({ customerId: seeded.ownCustomer, contactId: seeded.ownContact });
    const read = await get(created.id);
    expect(read.status).toBe(200);
    expect(LeadDtoSchema.parse(read.body)).toMatchObject({
      customerId: seeded.ownCustomer,
      contactId: seeded.ownContact,
    });
  });

  it('keeps a lead without a link free text, as before', async () => {
    const res = await post();
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(LeadDtoSchema.parse(res.body)).toMatchObject({ customerId: null, contactId: null });
  });

  it('links a customer without a contact', async () => {
    const res = await post({ customerId: seeded.ownCustomer });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(LeadDtoSchema.parse(res.body)).toMatchObject({
      customerId: seeded.ownCustomer,
      contactId: null,
    });
  });

  it('refuses a customer the caller may not read: 404, and no lead and no LD number is used', async () => {
    h.as('salesA', 'marketing');
    const before = await post();
    expect(before.status).toBe(201);
    const refused = await post({ customerId: seeded.colleagueCustomer });
    expect(refused.status).toBe(404);
    expect(errorOf(refused.body).code).toBe('not_found');
    // The refusal says nothing about the customer.
    expect(refused.text).not.toContain('Colleague');
    const after = LeadDtoSchema.parse((await post()).body);
    const prev = LeadDtoSchema.parse(before.body);
    expect(Number(after.number.split('-').pop())).toBe(Number(prev.number.split('-').pop()) + 1);
  });

  it('refuses a customer of another tenant and a customer that does not exist, with the same 404', async () => {
    const foreign = await post({ customerId: seeded.otherTenantCustomer });
    const missing = await post({ customerId: randomUUID() });
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(errorOf(foreign.body)).toMatchObject({
      code: 'not_found',
      message: 'Customer not found',
    });
    expect(errorOf(foreign.body).message).toBe(errorOf(missing.body).message);
  });

  it('refuses a contact of another customer (400) and a contact without its customer (400)', async () => {
    const wrong = await post({
      customerId: seeded.ownCustomer,
      contactId: seeded.colleagueContact,
    });
    expect(wrong.status).toBe(400);
    expect(errorOf(wrong.body).message).toContain('not a contact of this customer');
    const orphan = await post({ contactId: seeded.ownContact });
    expect(orphan.status).toBe(400);
  });
});
