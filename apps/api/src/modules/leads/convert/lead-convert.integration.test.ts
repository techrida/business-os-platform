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

import { ErrorBodySchema, LeadDtoSchema, OpportunityDtoSchema } from '@bos/contracts';
import {
  activities,
  customerContactPhones,
  customerContacts,
  customers,
  leads,
  opportunities,
} from '@bos/db';
import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../../app.setup';
import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import { systemActor, withTx } from '../../../platform/db/tx';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { ErrorBodyFilter } from '../../../platform/tenancy/error-body.filter';
import { ActivitiesService } from '../../activities/activities.service';
import { ListActivitiesQuerySchema } from '../../activities/activities.types';
import { ListCustomersQuerySchema } from '../../customers/customers.types';
import { CustomersService } from '../../customers/customers.service';
import { OpportunitiesService } from '../../opportunities/opportunities.service';
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
let opportunitiesService: OpportunitiesService;
let activitiesService: ActivitiesService;
let customersService: CustomersService;

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
    h.roleCache,
    h.notify,
  );
  customersService = new CustomersService(h.db, numbering, authz, h.caller, audit);
  const convertService = new LeadConvertService(
    h.db,
    authz,
    audit,
    numbering,
    customersService,
    h.caller,
    h.roleCache,
  );
  opportunitiesService = new OpportunitiesService(
    h.db,
    authz,
    audit,
    h.caller,
    new LeadLostReasonsService(h.db, audit, h.caller),
  );
  activitiesService = new ActivitiesService(h.db, authz, audit, h.caller, h.roleCache, h.notify);
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
const usPhone = () => `+1415555${String(Math.floor(Math.random() * 1e4)).padStart(4, '0')}`;
/** One phone row as the contact and lead forms send it (FX9). */
const phoneRow = (e164: string, country = 'NP', isPrimary = true) => ({ country, e164, isPrimary });
/** A Nepal PAN: nine digits. */
const panOf = () => String(100_000_000 + Math.floor(Math.random() * 899_999_999));
const ADDRESS = { line: '1 Durbar Marg', city: 'Kathmandu' };
const customerBody = (extra: Record<string, unknown> = {}) => ({
  legalName: `Convert${tag()} Traders Pvt. Ltd.`,
  country: 'NP',
  address: ADDRESS,
  ...extra,
});
const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;

/** FR-6 (D48): the move to contacted logs a contact in the same request; other moves carry none. */
const contactWith = (stage: string) =>
  stage === 'contacted' ? { contactActivity: { kind: 'call', body: 'Intro call' } } : {};

/** A lead that reached qualified through the real stage route, so its version is 3. */
async function qualifiedLead(extra: Record<string, unknown> = {}) {
  const created = await request(baseUrl)
    .post('/v1/leads')
    .send({
      title: 'Website for Acme',
      source: 'referral',
      companyName: 'Acme Pvt. Ltd.',
      contactName: 'Sita Rai',
      country: 'NP',
      email: `lead.${tag()}@convert.example`,
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
      .send({ stage, expectedVersion, ...contactWith(stage) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  }
  return lead;
}

const convert = (leadId: string, body: Record<string, unknown>, key: string = randomUUID()) =>
  request(baseUrl).post(`/v1/leads/${leadId}/convert`).set('Idempotency-Key', key).send(body);

/** A new contact with its own email: a conversion always names a contact that can receive a quotation. */
const newContact = () => ({
  mode: 'create',
  contact: { fullName: 'Buyer', email: `buyer.${tag()}@convert.example`, country: 'NP' },
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
/** The only contact of a customer, with its numbers in their saved order. */
const contactOf = async (customerId: string) => {
  const rows = await h.db
    .select()
    .from(customerContacts)
    .where(eq(customerContacts.customerId, customerId));
  expect(rows).toHaveLength(1);
  const phones = await h.db
    .select({
      country: customerContactPhones.country,
      e164: customerContactPhones.e164,
      isPrimary: customerContactPhones.isPrimary,
      sortOrder: customerContactPhones.sortOrder,
    })
    .from(customerContactPhones)
    .where(eq(customerContactPhones.contactId, rows[0]!.id))
    .orderBy(asc(customerContactPhones.sortOrder));
  return { ...rows[0]!, phones };
};

describe('POST /v1/leads/:id/convert', () => {
  it('refuses a short PAN for a Nepal customer and keeps a foreign tax id loose (FX8)', async () => {
    const lead = await qualifiedLead();
    const contact = {
      mode: 'create',
      contact: { fullName: 'Sita Rai', email: `s.${tag()}@convert.example`, country: 'NP' },
    };
    const short = await convert(
      lead.id,
      createCustomerBody(customerBody({ panVatNo: '12345' }), { contact }),
    );
    expect(short.status, JSON.stringify(short.body)).toBe(400);
    expect(errorOf(short.body).message).toContain('PAN');
    const badPhone = await convert(
      lead.id,
      createCustomerBody(customerBody({ panVatNo: panOf() }), {
        contact: {
          mode: 'create',
          contact: {
            fullName: 'Sita Rai',
            email: `s.${tag()}@convert.example`,
            country: 'NP',
            phones: [phoneRow('+9778123456789')],
          },
        },
      }),
    );
    expect(badPhone.status, JSON.stringify(badPhone.body)).toBe(400);
    const abroad = await convert(
      lead.id,
      createCustomerBody(
        customerBody({
          panVatNo: `AAACH${tag()}C`,
          country: 'IN',
          address: { line: 'MG Road', city: 'Bengaluru' },
        }),
        { contact },
      ),
    );
    expect(abroad.status, JSON.stringify(abroad.body)).toBe(201);
  });

  it('creates the customer, the contact and the opportunity, and moves the lead to converted', async () => {
    const lead = await qualifiedLead();
    const email = `sita.${tag()}@convert.example`;
    const res = await convert(
      lead.id,
      createCustomerBody(customerBody({ panVatNo: panOf() }), {
        contact: {
          mode: 'create',
          contact: { fullName: 'Sita Rai', email, country: 'NP', phones: [phoneRow(phone())] },
        },
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

  it('copies the lead’s numbers, each with its country, to a new contact sent without any (FX9)', async () => {
    const mobile = phone();
    const abroad = usPhone();
    const lead = await qualifiedLead({
      phones: [phoneRow(mobile), phoneRow(abroad, 'US', false)],
    });
    const res = await convert(
      lead.id,
      createCustomerBody(customerBody({ panVatNo: panOf() }), {
        contact: {
          mode: 'create',
          contact: { fullName: 'Sita Rai', email: `copy.${tag()}@convert.example`, country: 'NP' },
        },
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { customerId } = res.body as { customerId: string };
    expect((await customerRow(customerId)).country).toBe('NP');
    const contact = await contactOf(customerId);
    expect(contact.country).toBe('NP');
    expect(contact.phones).toEqual([
      { country: 'NP', e164: mobile, isPrimary: true, sortOrder: 0 },
      { country: 'US', e164: abroad, isPrimary: false, sortOrder: 1 },
    ]);
  });

  it('gives a new contact no numbers when the body sends an empty list, the lead’s numbers removed (FX9 A2)', async () => {
    const lead = await qualifiedLead({
      phones: [phoneRow(phone()), phoneRow(usPhone(), 'US', false)],
    });
    const res = await convert(
      lead.id,
      createCustomerBody(customerBody({ panVatNo: panOf() }), {
        contact: {
          mode: 'create',
          contact: {
            fullName: 'Sita Rai',
            email: `none.${tag()}@convert.example`,
            country: 'NP',
            phones: [],
          },
        },
      }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { customerId } = res.body as { customerId: string };
    expect((await contactOf(customerId)).phones).toEqual([]);
  });

  it('converts a lead abroad: customer and contact keep its country, and no Nepal PAN is asked (FX9)', async () => {
    const abroad = usPhone();
    const lead = await qualifiedLead({ country: 'US', phones: [phoneRow(abroad, 'US')] });
    expect(lead.country).toBe('US');
    const email = `us.${tag()}@convert.example`;
    // A US tax id: not nine digits, which a Nepal customer would need.
    const taxId = `EIN-${tag()}`.toUpperCase();
    const body = (country: string) =>
      createCustomerBody(
        customerBody({
          country,
          address: { line: '1 Market St', city: 'San Francisco' },
          panVatNo: taxId,
        }),
        { contact: { mode: 'create', contact: { fullName: 'Jane Doe', email, country } } },
      );
    // The same tax id on a Nepal customer is refused: the 9-digit rule follows the country.
    const asNepal = await convert(lead.id, body('NP'));
    expect(asNepal.status, JSON.stringify(asNepal.body)).toBe(400);
    expect(errorOf(asNepal.body).message).toContain('PAN');

    const res = await convert(lead.id, body('US'));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { customerId } = res.body as { customerId: string };
    expect(await customerRow(customerId)).toMatchObject({
      country: 'US',
      panVatNo: taxId,
      addressLine: '1 Market St',
      addressCity: 'San Francisco',
    });
    const contact = await contactOf(customerId);
    expect(contact.country).toBe('US');
    expect(contact.phones).toEqual([
      { country: 'US', e164: abroad, isPrimary: true, sortOrder: 0 },
    ]);
  });

  it('warns when a number copied from the lead is another contact’s second number (FX9)', async () => {
    const customerId = await h.seedCustomer();
    const second = phone();
    const first = await qualifiedLead();
    const ok = await convert(first.id, {
      customer: { mode: 'existing', customerId },
      contact: {
        mode: 'create',
        contact: {
          fullName: 'Two Numbers',
          email: `two.${tag()}@convert.example`,
          country: 'NP',
          phones: [phoneRow(phone()), phoneRow(second, 'NP', false)],
        },
      },
      opportunityName: 'First',
      expectedVersion: 3,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    const contactId = (await leadRow(first.id)).contactId;

    const lead = await qualifiedLead({ phones: [phoneRow(second)] });
    const res = await convert(lead.id, {
      customer: { mode: 'existing', customerId },
      contact: {
        mode: 'create',
        contact: {
          fullName: 'Someone Else',
          email: `else.${tag()}@convert.example`,
          country: 'NP',
        },
      },
      opportunityName: 'Second',
      expectedVersion: 3,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(409);
    const wire = res.body as { error: { code: string; duplicates: unknown[] } };
    expect(wire.error.code).toBe('duplicate_found');
    expect(wire.error.duplicates).toEqual([
      expect.objectContaining({ kind: 'contact', id: contactId, customerId, matchedOn: 'phone' }),
    ]);
  });

  it('never names a contact of a customer the caller cannot read, even through its second number (FX9 A1)', async () => {
    // Seeded under Sales (every customer readable): a contact of salesB's customer and one of salesA's, each with a
    // second number.
    const hidden = await h.seedCustomer(h.users.salesB);
    const mine = await h.seedCustomer(h.users.salesA);
    const hiddenSecond = phone();
    const mineSecond = phone();
    const contactOn = async (customerId: string, fullName: string, second: string) => {
      const lead = await qualifiedLead();
      const res = await convert(lead.id, {
        customer: { mode: 'existing', customerId },
        contact: {
          mode: 'create',
          contact: {
            fullName,
            email: `seed.${tag()}@convert.example`,
            country: 'NP',
            phones: [phoneRow(phone()), phoneRow(second, 'NP', false)],
          },
        },
        opportunityName: fullName,
        expectedVersion: 3,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      return (await leadRow(lead.id)).contactId!;
    };
    const hiddenContact = await contactOn(hidden, 'Hiddenmark Buyer', hiddenSecond);
    const mineContact = await contactOn(mine, 'Visible Buyer', mineSecond);
    const both = await qualifiedLead();
    const onlyHidden = await qualifiedLead();

    // The same salesperson, now allowed to convert but to read and write only the customers they own.
    const originalCurrent = h.caller.current;
    const originalAssert = h.authz.assert;
    const scoped = () => {
      const c = originalCurrent();
      const grants = new Map(c.principal.grants);
      grants.set('customer.read', 'own');
      grants.set('customer.write', 'own');
      return { ...c, principal: { ...c.principal, grants } };
    };
    h.caller.current = scoped;
    h.authz.assert = (action, ref) => {
      const d = can(scoped().principal, action, ref);
      if (!d.allowed) {
        throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: d.reason });
      }
    };
    try {
      const body = (numbers: string[]) => ({
        customer: { mode: 'existing', customerId: mine },
        contact: {
          mode: 'create',
          contact: {
            fullName: 'New Buyer',
            email: `new.${tag()}@convert.example`,
            country: 'NP',
            phones: numbers.map((n, i) => phoneRow(n, 'NP', i === 0)),
          },
        },
        opportunityName: 'Scoped',
        expectedVersion: 3,
      });
      const expectNoLeak = (text: string) => {
        expect(text).not.toContain(hidden);
        expect(text).not.toContain(hiddenContact);
        expect(text).not.toContain('Hiddenmark');
      };

      // Both second numbers match: only the readable customer's contact is named.
      const warned = await convert(both.id, body([hiddenSecond, mineSecond]));
      expect(warned.status, JSON.stringify(warned.body)).toBe(409);
      const wire = warned.body as { error: { code: string; duplicates: unknown[] } };
      expect(wire.error.code).toBe('duplicate_found');
      expect(wire.error.duplicates).toEqual([
        expect.objectContaining({
          kind: 'contact',
          id: mineContact,
          customerId: mine,
          matchedOn: 'phone',
        }),
      ]);
      expectNoLeak(JSON.stringify(warned.body));

      // Only the hidden contact's second number matches: no warning, the conversion goes through.
      const done = await convert(onlyHidden.id, body([hiddenSecond]));
      expect(done.status, JSON.stringify(done.body)).toBe(201);
      expect((done.body as { customerId: string }).customerId).toBe(mine);
      expectNoLeak(JSON.stringify(done.body));
    } finally {
      h.caller.current = originalCurrent;
      h.authz.assert = originalAssert;
    }
  });

  it('links an existing customer and a new contact, and numbers deals one after the other', async () => {
    const customerId = await h.seedCustomer();
    const first = await qualifiedLead();
    const second = await qualifiedLead();
    const body = (email: string) => ({
      customer: { mode: 'existing', customerId },
      contact: { mode: 'create', contact: { fullName: 'Hari Shah', email, country: 'NP' } },
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
      contact: {
        mode: 'create',
        contact: { fullName: 'Phone Only', country: 'NP', phones: [phoneRow(phone())] },
      },
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

  it('converts a lead linked to a customer into that customer, with no duplicate warning (R6O)', async () => {
    const customerId = await h.seedCustomer();
    // Another customer the old company-name check would have flagged: the link already answers it.
    await h.seedCustomer();
    const lead = await qualifiedLead({ companyName: 'Acme Pvt. Ltd.', customerId });
    expect(lead.customerId).toBe(customerId);
    const res = await convert(lead.id, {
      customer: { mode: 'existing', customerId },
      contact: {
        mode: 'create',
        contact: { fullName: 'Sita Rai', email: `sita.${tag()}@convert.example`, country: 'NP' },
      },
      opportunityName: 'Linked',
      expectedVersion: 3,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body as { customerId: string }).customerId).toBe(customerId);
    expect(await leadRow(lead.id)).toMatchObject({ stage: 'converted', customerId });
  });

  it('refuses to create a second customer for a lead that is linked to one, and writes nothing (R6O)', async () => {
    const customerId = await h.seedCustomer();
    const lead = await qualifiedLead({ customerId });
    const res = await convert(
      lead.id,
      createCustomerBody(customerBody({ legalName: `Second ${tag()} Pvt. Ltd.` })),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(errorOf(res.body).message).toContain('linked to a customer');
    expect(await leadRow(lead.id)).toMatchObject({ stage: 'qualified', customerId, version: 3 });
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
      contact: {
        mode: 'create',
        contact: { fullName: 'Gita Rai', email, country: 'NP', phones: [phoneRow(mobile)] },
      },
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
        contact: {
          fullName: 'Gita R.',
          email: email.toUpperCase(),
          country: 'NP',
          phones: [phoneRow(mobile)],
        },
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
    const pan = panOf();
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

  it("the wizard's PAN lookup finds the customer with that PAN, and converting into it links it and creates none (R6T)", async () => {
    // What the convert wizard asks while a PAN is typed: the customer list searched by the number, read as the signed-in
    // user. A hit is then chosen ("Use this customer") and the conversion links it instead of creating a duplicate.
    const pan = panOf();
    const original = await qualifiedLead();
    const first = await convert(original.id, createCustomerBody(customerBody({ panVatNo: pan })));
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const existingId = (first.body as { customerId: string }).customerId;
    const before = await h.db.select({ id: customers.id }).from(customers);

    const found = await customersService.list(
      ListCustomersQuerySchema.parse({ q: pan, limit: 20 }),
    );
    const same = found.items.filter((c) => c.panVatNo === pan && c.mergedIntoId === null);
    expect(same.map((c) => c.id)).toEqual([existingId]);

    const lead = await qualifiedLead();
    const res = await convert(lead.id, {
      customer: { mode: 'existing', customerId: same[0]!.id },
      contact: newContact(),
      opportunityName: 'Deal for the customer with this PAN',
      expectedVersion: 3,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect((res.body as { customerId: string }).customerId).toBe(existingId);
    expect(await h.db.select({ id: customers.id }).from(customers)).toHaveLength(before.length);
    const withPan = await h.db.select().from(customers).where(eq(customers.panVatNo, pan));
    expect(withPan).toHaveLength(1);
    expect(await leadRow(lead.id)).toMatchObject({ stage: 'converted' });
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
      .send({
        title: 'Early',
        source: 'website',
        companyName: 'Early Co',
        contactName: 'Ram',
        country: 'NP',
        email: `early.${tag()}@convert.example`,
      });
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

describe("the new customer's owner (customers.owner.write, as on POST /v1/customers)", () => {
  const customersNamed = (legalName: string) =>
    h.db.select().from(customers).where(eq(customers.legalName, legalName));

  it('refuses Sales (customer.write only) naming another owner with 403 and writes nothing; the same body naming the caller goes through', async () => {
    const lead = await qualifiedLead();
    const fields = customerBody();
    const named = (ownerUserId: string) => createCustomerBody({ ...fields, ownerUserId });

    const denied = await convert(lead.id, named(h.users.salesB));
    expect(denied.status, JSON.stringify(denied.body)).toBe(403);
    expect(errorOf(denied.body)).toMatchObject({ code: 'forbidden', reason: 'no_permission' });
    expect(await customersNamed(fields.legalName)).toHaveLength(0);
    expect(await leadRow(lead.id)).toMatchObject({
      stage: 'qualified',
      version: 3,
      customerId: null,
      contactId: null,
      convertedOpportunityId: null,
    });
    expect(
      await h.db.select().from(opportunities).where(eq(opportunities.leadId, lead.id)),
    ).toHaveLength(0);

    // Only the owner differs: naming the caller is no owner change.
    const self = await convert(lead.id, named(h.users.salesA));
    expect(self.status, JSON.stringify(self.body)).toBe(201);
    const { customerId } = self.body as { customerId: string };
    expect(await customerRow(customerId)).toMatchObject({
      legalName: fields.legalName,
      ownerUserId: h.users.salesA,
    });
  });

  it('lets Sales name no owner: the caller becomes the owner', async () => {
    const lead = await qualifiedLead();
    const res = await convert(lead.id, createCustomerBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { customerId } = res.body as { customerId: string };
    expect(await customerRow(customerId)).toMatchObject({ ownerUserId: h.users.salesA });
  });

  it('lets a salesperson who also holds customers.owner.write (Sales and Management roles) name another owner', async () => {
    // Management alone holds no lead write, so the holder is a member with both shipped roles, granted through the
    // real RoleCache: Sales gives the lead and customer writes, Management the owner change.
    const both = await h.member({ roles: ['sales', 'management'], displayName: 'Sana Both' });
    await h.actAs(both);
    const lead = await qualifiedLead();
    const fields = customerBody();
    const res = await convert(
      lead.id,
      createCustomerBody({ ...fields, ownerUserId: h.users.salesB }),
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { customerId } = res.body as { customerId: string };
    expect(await customerRow(customerId)).toMatchObject({
      legalName: fields.legalName,
      ownerUserId: h.users.salesB,
    });
    expect(await leadRow(lead.id)).toMatchObject({ stage: 'converted', customerId });
  });
});

describe('the lead creator on the opportunity (FX-Q1)', () => {
  let salesStaff: string;
  let pmo: string;
  let colleague: string;

  beforeAll(async () => {
    const salesDept = await h.department('Sales FX');
    salesStaff = await h.member({ roles: ['sales'], departmentId: salesDept, displayName: 'Sam' });
    colleague = await h.member({ roles: ['sales'], departmentId: salesDept, displayName: 'Cora' });
    // PMO reads opportunities at `own` only, with no department in common with Sales: the lead creator is the
    // one way it reaches a deal. (Finance and Accountant read every deal since 0123, so they cannot show it.)
    pmo = await h.member({ roles: ['pmo'], displayName: 'Pia PMO' });
  });

  it('records who entered the lead, so PMO opens the deal it became and may quote on it', async () => {
    // A deal PMO had no part in, the control: Sales enters and converts the lead itself.
    await h.actAs(salesStaff);
    const other = await qualifiedLead();
    const otherRes = await convert(other.id, createCustomerBody());
    expect(otherRes.status, JSON.stringify(otherRes.body)).toBe(201);
    const { opportunityId: controlId } = otherRes.body as { opportunityId: string };

    // PMO enters the lead for a Sales owner (D50) ...
    await h.actAs(pmo);
    const created = await request(baseUrl)
      .post('/v1/leads')
      .send({
        title: 'PMO referral',
        source: 'referral',
        companyName: 'Acme Pvt. Ltd.',
        contactName: 'Sita Rai',
        country: 'NP',
        email: `pmo.${tag()}@convert.example`,
        ownerUserId: salesStaff,
      });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const lead = LeadDtoSchema.parse(created.body);
    // ... and reaches no deal it did not originate.
    await expect(opportunitiesService.get(controlId)).rejects.toMatchObject({ status: 404 });
    const before = await opportunitiesService.list({ limit: 50, offset: 0 });
    expect(before.items.map((o) => o.id)).not.toContain(controlId);

    // The owner qualifies and converts it.
    await h.actAs(salesStaff);
    for (const [stage, expectedVersion] of [
      ['contacted', 1],
      ['qualified', 2],
    ] as const) {
      const moved = await request(baseUrl)
        .patch(`/v1/leads/${lead.id}/stage`)
        .send({ stage, expectedVersion, ...contactWith(stage) });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    }
    const res = await convert(lead.id, createCustomerBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { opportunityId } = res.body as { opportunityId: string };

    // PMO holds crm.opportunity.read `own`: the creator reach now covers this deal, read only, and still not the
    // control.
    await h.actAs(pmo);
    const seen = OpportunityDtoSchema.parse(await opportunitiesService.get(opportunityId));
    expect(seen).toMatchObject({
      id: opportunityId,
      ownerUserId: salesStaff,
      canEdit: false,
      canDraftQuotation: true,
      allowedMoves: [],
    });
    const listed = await opportunitiesService.list({ limit: 50, offset: 0 });
    expect(listed.items.map((o) => o.id)).toContain(opportunityId);
    expect(listed.items.map((o) => o.id)).not.toContain(controlId);
    await expect(opportunitiesService.get(controlId)).rejects.toMatchObject({ status: 404 });
    expect(await opportunityRow(opportunityId)).toMatchObject({
      ownerUserId: salesStaff,
      leadCreatorUserId: pmo,
    });
    // Reading is not changing the deal (D55-3): PMO holds no opportunity write at all.
    await expect(
      opportunitiesService.changeStage(opportunityId, {
        stage: 'requirement_received',
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({ status: 403 });

    // A colleague with only an assigned follow-up reads the deal but may not quote on it (FX-Q2).
    await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
      tx.insert(activities).values({
        ...h.scopeA,
        kind: 'call',
        subject: 'Call the buyer',
        opportunityId,
        dueAt: new Date(Date.now() + 86_400_000),
        assigneeUserId: colleague,
        createdByUserId: salesStaff,
      }),
    );
    await h.actAs(colleague);
    expect(OpportunityDtoSchema.parse(await opportunitiesService.get(opportunityId))).toMatchObject(
      {
        canEdit: false,
        canDraftQuotation: false,
      },
    );
    // The owner may.
    await h.actAs(salesStaff);
    expect(OpportunityDtoSchema.parse(await opportunitiesService.get(opportunityId))).toMatchObject(
      {
        canEdit: true,
        canDraftQuotation: true,
      },
    );
  });

  it('leaves the lead creator empty for a lead without a known creator', async () => {
    const lead = await qualifiedLead();
    await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
      tx.update(leads).set({ createdByUserId: null }).where(eq(leads.id, lead.id)),
    );
    const res = await convert(lead.id, createCustomerBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { opportunityId } = res.body as { opportunityId: string };
    expect(await opportunityRow(opportunityId)).toMatchObject({ leadCreatorUserId: null });
  });
});

describe("a lead's open follow-ups carry to the opportunity (U16-Q6)", () => {
  let salesStaff: string;
  let peer: string;
  let marketing: string;

  beforeAll(async () => {
    const salesDept = await h.department('Sales Carry');
    salesStaff = await h.member({ roles: ['sales'], departmentId: salesDept, displayName: 'Sam' });
    peer = await h.member({ roles: ['sales'], departmentId: salesDept, displayName: 'Pia' });
    marketing = await h.member({ roles: ['marketing'], displayName: 'Maya Marketing' });
  });

  const activityRow = async (id: string) =>
    (await h.db.select().from(activities).where(eq(activities.id, id)))[0]!;

  async function onLead(
    leadId: string,
    assigneeUserId: string | null,
    extra: { subject: string; body?: string; due?: boolean; completed?: boolean },
  ) {
    const [row] = await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
      tx
        .insert(activities)
        .values({
          ...h.scopeA,
          kind: 'call',
          subject: extra.subject,
          body: extra.body ?? null,
          leadId,
          dueAt: extra.due === false ? null : new Date('2026-12-01T09:30:00Z'),
          assigneeUserId,
          createdByUserId: salesStaff,
          completedAt: extra.completed === true ? new Date() : null,
        })
        .returning(),
    );
    return row!;
  }

  it('moves the planned follow-ups, with assignee, due time and text, and keeps the history on the lead', async () => {
    await h.actAs(salesStaff);
    const lead = await qualifiedLead();
    const mine = await onLead(lead.id, salesStaff, {
      subject: 'Send proposal',
      body: 'Bring pricing',
    });
    const peers = await onLead(lead.id, peer, { subject: 'Site visit' });
    const done = await onLead(lead.id, salesStaff, { subject: 'First call', completed: true });
    const logged = await onLead(lead.id, salesStaff, { subject: 'Logged call', due: false });

    const res = await convert(lead.id, createCustomerBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { opportunityId } = res.body as { opportunityId: string };

    for (const before of [mine, peers]) {
      const after = await activityRow(before.id);
      expect(after).toMatchObject({
        leadId: null,
        opportunityId,
        assigneeUserId: before.assigneeUserId,
        dueAt: before.dueAt,
        subject: before.subject,
        body: before.body,
        kind: before.kind,
        completedAt: null,
        cancelledAt: null,
        version: before.version + 1,
      });
    }
    for (const kept of [done, logged]) {
      expect(await activityRow(kept.id)).toMatchObject({ leadId: lead.id, opportunityId: null });
    }
    const { rows } = await h.ownerPool.query(
      `SELECT entity_id, before, after FROM audit.audit_events
        WHERE tenant_id = $1 AND action = 'activity.carried_to_opportunity' ORDER BY entity_id`,
      [h.tenantId],
    );
    const carried = (rows as { entity_id: string; before: unknown; after: unknown }[]).filter(
      (r) => r.entity_id === mine.id || r.entity_id === peers.id,
    );
    expect(carried).toHaveLength(2);
    for (const r of carried) {
      expect(r.before).toEqual({ leadId: lead.id });
      expect(r.after).toEqual({ opportunityId });
    }

    // The owner lists them as the deal's planned activities, and plans a new one through the same API.
    const planned = ListActivitiesQuerySchema.parse({ opportunityId, status: 'planned' });
    expect((await activitiesService.list(planned)).items.map((a) => a.id).sort()).toEqual(
      [mine.id, peers.id].sort(),
    );
    const added = await activitiesService.create({
      kind: 'meeting',
      subject: 'Negotiation meeting',
      dueAt: '2026-12-05T10:00:00.000Z',
      opportunityId,
    });
    expect(added).toMatchObject({ opportunityId, planned: true, assigneeUserId: salesStaff });
    expect((await activitiesService.list(planned)).items.map((a) => a.id)).toContain(added.id);

    // The peer still holds their follow-up on the deal and completes it there (D55-5).
    await h.actAs(peer);
    const theirs = (await activitiesService.list(planned)).items.find((a) => a.id === peers.id);
    expect(theirs).toBeDefined();
    expect(
      await activitiesService.complete(peers.id, { expectedVersion: theirs!.version }),
    ).toMatchObject({ id: peers.id, planned: false, opportunityId });
  });

  /**
   * A colleague's change to a follow-up, held uncommitted on a second connection (raw SQL standing in for the
   * complete and reschedule routes) while the lead converts; committed once the convert waits on it. Returns the
   * wait the convert was in, whether it was still pending at the commit, and its response.
   *
   * These pin a serialization the carry relies on rather than test a lock of its own: every audited write takes the
   * tenant's audit chain lock until COMMIT (audit.append, 0008_audit_hardening.sql), and the convert's first
   * statement is its audited Idempotency-Key row. So a colleague's change lands wholly before the convert reads the
   * lead's follow-ups, or after it commits, never between the read and the move. They go red if that is loosened.
   */
  async function convertWhileHeld(leadId: string, change: string, params: unknown[]) {
    // The harness types its pools by the calls it makes; this one is a real pg Pool.
    const client = await (h.ownerPool as unknown as Pool).connect();
    let converting: Promise<request.Response> | undefined;
    try {
      await client.query('BEGIN');
      // What withTx sets first: the audit trigger on activities names the actor.
      const actor = systemActor('test');
      await client.query(
        `SELECT set_config('bos.tenant_id', $1, true), set_config('bos.organization_id', $2, true),
                set_config('bos.actor_kind', $3, true), set_config('bos.actor_id', $4, true),
                set_config('bos.correlation_id', $5, true)`,
        [h.scopeA.tenantId, h.scopeA.organizationId, actor.kind, actor.id, actor.correlationId],
      );
      await client.query(change, params);
      let settled = false;
      converting = convert(leadId, createCustomerBody()).then((res) => {
        settled = true;
        return res;
      });
      // Wait for a signal, not a clock: either the convert is blocked on a lock, or it finished.
      let blocked: { query: string; wait_event: string } | undefined;
      while (blocked === undefined && !settled) {
        const { rows } = await h.appPool.query(
          `SELECT query, wait_event FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        blocked = (rows as { query: string; wait_event: string }[])[0];
        if (blocked === undefined) await new Promise((resolve) => setImmediate(resolve));
      }
      const pendingAtCommit = !settled;
      await client.query('COMMIT');
      return { blocked, pendingAtCommit, res: await converting };
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      await converting?.catch(() => undefined);
      client.release();
    }
  }

  it('leaves a follow-up completed while the lead converts on the lead, as its history', async () => {
    await h.actAs(salesStaff);
    const lead = await qualifiedLead();
    const call = await onLead(lead.id, salesStaff, { subject: 'Call back' });
    const { blocked, pendingAtCommit, res } = await convertWhileHeld(
      lead.id,
      `UPDATE app.activities SET completed_at = now(), version = version + 1 WHERE id = $1`,
      [call.id],
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(pendingAtCommit, 'the convert did not wait for the colleague').toBe(true);
    // It waits for the tenant audit lock withTx takes first, before it reads the lead's follow-ups.
    expect(blocked).toMatchObject({ wait_event: 'advisory' });
    expect(blocked?.query).toMatch(/pg_advisory_xact_lock\(hashtextextended\('audit\.chain:'/);
    const after = await activityRow(call.id);
    expect(after).toMatchObject({ leadId: lead.id, opportunityId: null });
    expect(after.completedAt).not.toBeNull();
  });

  it('leaves a follow-up on the lead when it is handed, while the lead converts, to someone who cannot open deals', async () => {
    await h.actAs(salesStaff);
    const lead = await qualifiedLead();
    const call = await onLead(lead.id, salesStaff, { subject: 'Send the brochure' });
    const { blocked, pendingAtCommit, res } = await convertWhileHeld(
      lead.id,
      `UPDATE app.activities SET assignee_user_id = $2, version = version + 1 WHERE id = $1`,
      [call.id, marketing],
    );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(pendingAtCommit, 'the convert did not wait for the colleague').toBe(true);
    expect(blocked).toMatchObject({ wait_event: 'advisory' });
    expect(await activityRow(call.id)).toMatchObject({
      leadId: lead.id,
      opportunityId: null,
      assigneeUserId: marketing,
      completedAt: null,
    });
  });

  it('leaves a follow-up on the lead when its assignee cannot open deals (Marketing)', async () => {
    await h.actAs(salesStaff);
    const lead = await qualifiedLead();
    const theirs = await onLead(lead.id, marketing, { subject: 'Send the brochure' });
    const mine = await onLead(lead.id, salesStaff, { subject: 'Book the demo' });
    const res = await convert(lead.id, createCustomerBody());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { opportunityId } = res.body as { opportunityId: string };
    expect(await activityRow(mine.id)).toMatchObject({ leadId: null, opportunityId });
    expect(await activityRow(theirs.id)).toMatchObject({
      leadId: lead.id,
      opportunityId: null,
      assigneeUserId: marketing,
      version: theirs.version,
    });
    // Still theirs to finish, on the converted lead they can open.
    await h.actAs(marketing);
    const listed = await activitiesService.list(
      ListActivitiesQuerySchema.parse({ status: 'planned' }),
    );
    expect(listed.items.map((a) => a.id)).toContain(theirs.id);
    expect(
      await activitiesService.complete(theirs.id, { expectedVersion: theirs.version }),
    ).toMatchObject({ id: theirs.id, planned: false });
  });
});
