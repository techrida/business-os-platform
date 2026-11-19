// Integration tests of POST /v1/leads/:id/convert on a real Postgres (Testcontainers, needs Docker in WSL). Real:
// migrations, LeadConvertService, CustomersService, LeadsService, NumberingService, AuditService, and the controllers
// behind the production body parser and error filter, so `error.duplicates` is read off the wire. Faked: the request
// context and authz.assert (see ../test/harness.ts).
// One database serves the whole file and `seedCustomer` already holds the name "acme", so every new customer, e-mail,
// phone and PAN below carries a fresh tag; otherwise the happy path would answer duplicate_found.
// Run: pnpm --filter @bos/api exec vitest run src/modules/leads/convert
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ErrorBodySchema, LeadDtoSchema } from '@bos/contracts';
import { activities, customerContacts, customers, leads, opportunities } from '@bos/db';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../../app.setup';
import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { systemActor, withTx } from '../../../platform/db/tx';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { ErrorBodyFilter } from '../../../platform/tenancy/error-body.filter';
import { CustomersService } from '../../customers/customers.service';
import { LeadsController } from '../leads.controller';
import { LeadsService } from '../leads.service';
import { LeadLostReasonsService } from '../lost-reasons.service';
import { startHarness, type Harness } from '../test/harness';
import { LeadConvertController } from './lead-convert.controller';
import { LeadConvertService } from './lead-convert.service';
import { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import { SettingsService } from '../../../platform/settings/settings.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let h: Harness;
let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  const authz = h.authz as unknown as AuthzService;
  const numbering = new NumberingService();
  const audit = new AuditService(h.db);
  const leadsService = new LeadsService(
    h.db,
    authz,
    audit,
    numbering,
    h.caller,
    new CurrencyEnabledService(new SettingsService(h.db)),
    new LeadLostReasonsService(h.db, audit, h.caller),
  );
  const customersService = new CustomersService(h.db, numbering, authz, h.caller);
  const convertService = new LeadConvertService(
    h.db,
    authz,
    audit,
    numbering,
    customersService,
    h.caller,
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [LeadsController, LeadConvertController],
    providers: [
      { provide: LeadsService, useValue: leadsService },
      { provide: LeadConvertService, useValue: convertService },
    ],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  configureApp(app);
  app.useGlobalFilters(new ErrorBodyFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await h?.stop();
});

beforeEach(() => {
  h.as('salesA', 'sales');
});

const tag = () => randomUUID().replace(/-/g, '').slice(0, 8);
const phone = () => `+97798${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
const ADDRESS = { line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' };
const customerBody = (extra: Record<string, unknown> = {}) => ({
  legalName: `Convert${tag()} Traders Pvt. Ltd.`,
  address: ADDRESS,
  ...extra,
});
const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;

/** A lead that reached qualified through the real stage route, so its version is 3. */
async function qualifiedLead(extra: Record<string, unknown> = {}) {
  const created = await request(baseUrl)
    .post('/v1/leads')
    .send({
      title: 'Website for Acme',
      source: 'referral',
      companyName: 'Acme Pvt. Ltd.',
      contactName: 'Sita Rai',
      expectedValue: '150000.00',
      currency: 'USD',
      probability: 60,
      expectedClose: '2026-12-31',
      ...extra,
    });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const lead = LeadDtoSchema.parse(created.body);
  for (const [stage, expectedVersion] of [
    ['contacted', 1],
    ['qualified', 2],
  ] as const) {
    const res = await request(baseUrl)
      .patch(`/v1/leads/${lead.id}/stage`)
      .send({ stage, expectedVersion });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return lead;
}

const convert = (leadId: string, body: Record<string, unknown>, key: string = randomUUID()) =>
  request(baseUrl).post(`/v1/leads/${leadId}/convert`).set('Idempotency-Key', key).send(body);

/** A new contact with its own email: a conversion always names a contact that can receive a quotation. */
const newContact = () => ({
  mode: 'create',
  contact: { fullName: 'Buyer', email: `buyer.${tag()}@convert.example` },
});
const createCustomerBody = (customer: Record<string, unknown> = customerBody(), extra = {}) => ({
  customer: { mode: 'create', customer },
  contact: newContact(),
  opportunityName: 'Acme website',
  expectedVersion: 3,
  ...extra,
});

const leadRow = async (id: string) => {
  const [r] = await h.db.select().from(leads).where(eq(leads.id, id));
  return r!;
};
const opportunityRow = async (id: string) => {
  const [r] = await h.db.select().from(opportunities).where(eq(opportunities.id, id));
  return r!;
};
const customerRow = async (id: string) => {
  const [r] = await h.db.select().from(customers).where(eq(customers.id, id));
  return r!;
};

describe('POST /v1/leads/:id/convert', () => {
  it('creates the customer, the contact and the opportunity, and moves the lead to converted', async () => {
    const lead = await qualifiedLead();
    const email = `sita.${tag()}@convert.example`;
    const res = await convert(
      lead.id,
      createCustomerBody(customerBody({ panVatNo: `pan-${tag()}` }), {
        contact: { mode: 'create', contact: { fullName: 'Sita Rai', email, phone: phone() } },
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { opportunityId, customerId } = res.body as { opportunityId: string; customerId: string };

    const customer = await customerRow(customerId);
    expect(customer.number).toMatch(/^CUS-/);
    const [contact] = await h.db
      .select()
      .from(customerContacts)
      .where(eq(customerContacts.customerId, customerId));
    expect(contact).toMatchObject({ fullName: 'Sita Rai', emailNorm: email });

    const opportunity = await opportunityRow(opportunityId);
    expect(opportunity).toMatchObject({
      stage: 'qualified',
      name: 'Acme website',
      customerId,
      contactId: contact!.id,
      leadId: lead.id,
      ownerUserId: h.users.salesA,
      value: '150000.00',
      currency: 'USD',
      probability: 60,
      expectedClose: '2026-12-31',
      version: 1,
    });
    expect(opportunity.number).toMatch(/^DEAL-/);

    expect(await leadRow(lead.id)).toMatchObject({
      stage: 'converted',
      customerId,
      contactId: contact!.id,
      convertedOpportunityId: opportunityId,
      version: 4,
    });
    expect((await h.auditOf(lead.id)).map((e) => e.action)).toContain('lead.converted');
    const stageActivities = await h.db
      .select()
      .from(activities)
      .where(eq(activities.leadId, lead.id));
    const converted = stageActivities.filter((a) => a.subject.endsWith('to converted'));
    expect(converted).toHaveLength(1);
    // The caller is recorded as who converted it, as on a stage change.
    expect(converted[0]).toMatchObject({ kind: 'stage_change', createdByUserId: h.users.salesA });
  });

  it('links an existing customer and a new contact, and numbers deals one after the other', async () => {
    const customerId = await h.seedCustomer();
    const first = await qualifiedLead();
    const second = await qualifiedLead();
    const body = (email: string) => ({
      customer: { mode: 'existing', customerId },
      contact: { mode: 'create', contact: { fullName: 'Hari Shah', email } },
      opportunityName: 'Existing customer deal',
      expectedVersion: 3,
    });
    const a = await convert(first.id, body(`hari.${tag()}@convert.example`));
    const b = await convert(second.id, body(`hari.${tag()}@convert.example`));
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect((a.body as { customerId: string }).customerId).toBe(customerId);
    const numbers = await Promise.all(
      [a, b].map(
        async (r) =>
          (await opportunityRow((r.body as { opportunityId: string }).opportunityId)).number,
      ),
    );
    expect(numbers[0]).not.toBe(numbers[1]);
    // An existing customer is not renumbered or duplicated.
    const copies = await h.db.select().from(customers).where(eq(customers.id, customerId));
    expect(copies).toHaveLength(1);
  });

  it('refuses a conversion without a contact, or with a new contact that has no email (400)', async () => {
    const customerId = await h.seedCustomer();
    const lead = await qualifiedLead();
    const base = { customer: { mode: 'existing', customerId }, expectedVersion: 3 };
    const none = await convert(lead.id, { ...base, opportunityName: 'No contact' });
    expect(none.status, JSON.stringify(none.body)).toBe(400);
    const noEmail = await convert(lead.id, {
      ...base,
      opportunityName: 'No email',
      contact: { mode: 'create', contact: { fullName: 'Phone Only', phone: phone() } },
    });
    expect(noEmail.status, JSON.stringify(noEmail.body)).toBe(400);
    const newCustomerNoContact = await convert(lead.id, {
      customer: { mode: 'create', customer: customerBody() },
      opportunityName: 'New customer, no contact',
      expectedVersion: 3,
    });
    expect(newCustomerNoContact.status).toBe(400);
    expect(await leadRow(lead.id)).toMatchObject({ stage: 'qualified', version: 3 });
    expect(
      await h.db.select().from(opportunities).where(eq(opportunities.leadId, lead.id)),
    ).toHaveLength(0);
  });

  it('refuses an existing contact without an email (422 contact_email_required) and links one with an email', async () => {
    const customerId = await h.seedCustomer();
    const insertContact = async (fullName: string, email: string | null) => {
      const [row] = await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
        tx
          .insert(customerContacts)
          .values({ tenantId: h.tenantId, customerId, fullName, emailNorm: email })
          .returning({ id: customerContacts.id }),
      );
      return row!.id;
    };
    const noEmail = await insertContact('Phone Only', null);
    const withEmail = await insertContact('Has Mail', `mail.${tag()}@convert.example`);
    const lead = await qualifiedLead();
    const body = (contactId: string) => ({
      customer: { mode: 'existing', customerId },
      contact: { mode: 'existing', contactId },
      opportunityName: 'Existing contact',
      expectedVersion: 3,
    });
    const refused = await convert(lead.id, body(noEmail));
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(errorOf(refused.body).code).toBe('contact_email_required');
    expect(await leadRow(lead.id)).toMatchObject({ stage: 'qualified', contactId: null });

    const linked = await convert(lead.id, body(withEmail));
    expect(linked.status, JSON.stringify(linked.body)).toBe(201);
    expect(await leadRow(lead.id)).toMatchObject({ customerId, contactId: withEmail });
  });

  it('answers 409 duplicate_found with error.duplicates on the wire, and writes nothing', async () => {
    const original = await qualifiedLead();
    const name = `Twin${tag()} Builders Pvt. Ltd.`;
    const created = await convert(
      original.id,
      createCustomerBody(customerBody({ legalName: name })),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const twinId = (created.body as { customerId: string }).customerId;

    const lead = await qualifiedLead();
    // The same company in other words: "Private Limited" and "Pvt. Ltd." normalise to the same name.
    const res = await convert(
      lead.id,
      createCustomerBody(customerBody({ legalName: name.replace('Pvt. Ltd.', 'PRIVATE LIMITED') })),
    );
    expect(res.status).toBe(409);
    expect(errorOf(res.body).code).toBe('duplicate_found');
    const wire = res.body as { error: { duplicates: unknown[] } };
    expect(wire.error.duplicates).toEqual([
      expect.objectContaining({ kind: 'customer', id: twinId, matchedOn: 'name' }),
    ]);
    expect(await leadRow(lead.id)).toMatchObject({ stage: 'qualified', version: 3 });
    const sameName = await h.db
      .select()
      .from(customers)
      .where(eq(customers.legalName, name.replace('Pvt. Ltd.', 'PRIVATE LIMITED')));
    expect(sameName).toHaveLength(0);
  });

  it('warns about a contact with the same e-mail or phone, naming the customer it belongs to', async () => {
    const customerId = await h.seedCustomer();
    const email = `dup.${tag()}@convert.example`;
    const mobile = phone();
    const first = await qualifiedLead();
    const ok = await convert(first.id, {
      customer: { mode: 'existing', customerId },
      contact: { mode: 'create', contact: { fullName: 'Gita Rai', email, phone: mobile } },
      opportunityName: 'First',
      expectedVersion: 3,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const contactId = (await leadRow(first.id)).contactId;

    const lead = await qualifiedLead();
    const res = await convert(lead.id, {
      customer: { mode: 'existing', customerId },
      // Same e-mail in capitals and the same phone: one entry that says both.
      contact: {
        mode: 'create',
        contact: { fullName: 'Gita R.', email: email.toUpperCase(), phone: mobile },
      },
      opportunityName: 'Second',
      expectedVersion: 3,
    });
    expect(res.status).toBe(409);
    const wire = res.body as { error: { code: string; duplicates: unknown[] } };
    expect(wire.error.code).toBe('duplicate_found');
    expect(wire.error.duplicates).toEqual([
      expect.objectContaining({
        kind: 'contact',
        id: contactId,
        customerId,
        matchedOn: 'email, phone',
      }),
    ]);
  });

  it('lets an override with a reason through, and records the reason in the audit trail', async () => {
    const original = await qualifiedLead();
    const name = `Again${tag()} Traders Pvt. Ltd.`;
    const first = await convert(original.id, createCustomerBody(customerBody({ legalName: name })));
    expect(first.status).toBe(201);

    const lead = await qualifiedLead();
    const reason = 'Separate branch with its own books';
    const res = await convert(
      lead.id,
      createCustomerBody(customerBody({ legalName: name }), { duplicateOverride: { reason } }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body as { customerId: string }).customerId).not.toBe(
      (first.body as { customerId: string }).customerId,
    );
    const { rows } = await h.ownerPool.query(
      `SELECT meta FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 AND action = 'lead.converted'`,
      [h.tenantId, lead.id],
    );
    expect(rows).toHaveLength(1);
    expect((rows[0] as { meta: Record<string, unknown> }).meta).toMatchObject({
      duplicateOverrideReason: reason,
    });
  });

  it('never overrides a PAN/VAT match: 409 duplicate_pan_vat, and nothing is written', async () => {
    const pan = `PAN-${tag()}`.toUpperCase();
    const original = await qualifiedLead();
    const first = await convert(original.id, createCustomerBody(customerBody({ panVatNo: pan })));
    expect(first.status, JSON.stringify(first.body)).toBe(201);

    const lead = await qualifiedLead();
    for (const override of [undefined, { reason: 'We know better' }]) {
      const res = await convert(
        lead.id,
        createCustomerBody(
          customerBody({ panVatNo: pan.toLowerCase() }),
          override === undefined ? {} : { duplicateOverride: override },
        ),
      );
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(errorOf(res.body).code).toBe('duplicate_pan_vat');
    }
    expect(await leadRow(lead.id)).toMatchObject({ stage: 'qualified', version: 3 });
  });

  it('refuses a second convert with 409, whether the version is fresh or stale', async () => {
    const customerId = await h.seedCustomer();
    const lead = await qualifiedLead();
    const body = {
      customer: { mode: 'existing', customerId },
      contact: newContact(),
      opportunityName: 'Once',
      expectedVersion: 3,
    };
    expect((await convert(lead.id, body)).status).toBe(201);

    // The current version (4) and a new key get past the version check, so the converted guard answers.
    const again = await convert(lead.id, { ...body, expectedVersion: 4 });
    expect(again.status).toBe(409);
    expect(errorOf(again.body)).toMatchObject({ code: 'conflict' });
    expect(errorOf(again.body).message).toMatch(/already converted/);
    expect((await convert(lead.id, body)).status).toBe(409);
    const deals = await h.db.select().from(opportunities).where(eq(opportunities.leadId, lead.id));
    expect(deals).toHaveLength(1);
  });

  it('replays the same Idempotency-Key without a second opportunity, and refuses it for another body', async () => {
    const customerId = await h.seedCustomer();
    const lead = await qualifiedLead();
    const key = `convert-${randomUUID()}`;
    const body = {
      customer: { mode: 'existing', customerId },
      contact: newContact(),
      opportunityName: 'Replay',
      expectedVersion: 3,
    };
    const a = await convert(lead.id, body, key);
    const b = await convert(lead.id, body, key);
    expect(a.status).toBe(201);
    expect(b.body).toEqual(a.body);
    const deals = await h.db.select().from(opportunities).where(eq(opportunities.leadId, lead.id));
    expect(deals).toHaveLength(1);
    expect((await convert(lead.id, { ...body, opportunityName: 'Other' }, key)).status).toBe(422);
  });

  it('refuses a lead that is not qualified and a stale version with 409, and a missing key with 400', async () => {
    const customerId = await h.seedCustomer();
    const fresh = await request(baseUrl)
      .post('/v1/leads')
      .send({ title: 'Early', source: 'website', companyName: 'Early Co', contactName: 'Ram' });
    const early = LeadDtoSchema.parse(fresh.body);
    const body = {
      customer: { mode: 'existing', customerId },
      contact: newContact(),
      opportunityName: 'Early',
      expectedVersion: 1,
    };
    const notQualified = await convert(early.id, body);
    expect(notQualified.status).toBe(409);
    expect(errorOf(notQualified.body).message).toMatch(/only a qualified lead/);

    const lead = await qualifiedLead();
    expect((await convert(lead.id, { ...body, expectedVersion: 2 })).status).toBe(409);
    const noKey = await request(baseUrl)
      .post(`/v1/leads/${lead.id}/convert`)
      .send({ ...body, expectedVersion: 3 });
    expect(noKey.status).toBe(400);
    expect(await leadRow(lead.id)).toMatchObject({ stage: 'qualified' });
  });

  it('answers 404 for a lead of another entity, a colleague lead and an unknown customer or contact', async () => {
    const customerId = await h.seedCustomer();
    const body = {
      customer: { mode: 'existing', customerId },
      contact: newContact(),
      opportunityName: 'X',
      expectedVersion: 3,
    };

    h.as('salesB', 'sales');
    const colleague = await qualifiedLead();
    h.as('salesB', 'sales', 'B');
    const otherEntity = await qualifiedLead();

    h.as('salesA', 'sales');
    for (const id of [colleague.id, otherEntity.id, '00000000-0000-4000-8000-000000000000']) {
      const res = await convert(id, body);
      expect(res.status, id).toBe(404);
      expect(errorOf(res.body).code).toBe('not_found');
    }
    // Still qualified: a 404 changed nothing.
    expect(await leadRow(otherEntity.id)).toMatchObject({ stage: 'qualified', version: 3 });

    const mine = await qualifiedLead();
    const ghost = await convert(mine.id, {
      ...body,
      customer: { mode: 'existing', customerId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(ghost.status).toBe(404);
    // An existing contact must belong to the chosen customer (here: it does not exist).
    const wrongContact = await convert(mine.id, {
      ...body,
      contact: { mode: 'existing', contactId: '00000000-0000-4000-8000-000000000000' },
    });
    expect(wrongContact.status).toBe(400);
    // An existing contact with a new customer cannot belong to it.
    const impossible = await convert(
      mine.id,
      createCustomerBody(customerBody(), {
        contact: { mode: 'existing', contactId: '00000000-0000-4000-8000-000000000000' },
      }),
    );
    expect(impossible.status).toBe(400);
  });

  it('refuses a caller without crm.lead.write with 403 and changes nothing', async () => {
    const lead = await qualifiedLead();
    h.as('viewer', 'management');
    const denied = await convert(lead.id, createCustomerBody());
    expect(denied.status).toBe(403);
    expect(await leadRow(lead.id)).toMatchObject({ stage: 'qualified' });
  });
});
