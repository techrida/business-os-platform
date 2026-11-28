// Integration tests of the lead lost reasons (D49) on a real Postgres (Testcontainers, needs Docker in WSL): the
// tenant's list, marking a lead lost with an option or a new one, the duplicate refusal, a retired option that stays on
// an old lead, and the Founder's rename, order and reset. Real: migrations, LeadsService, LeadLostReasonsService,
// AuditService and the controllers behind the production body parser and error filter. Faked: the request context and
// authz.assert (see test/harness.ts); the route guard is not mounted, so the route permissions are read from metadata.
// Run: pnpm --filter @bos/api exec vitest run src/modules/leads/leads.lost-reasons.integration.test.ts
import 'reflect-metadata';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  DEFAULT_LEAD_LOST_REASONS,
  ErrorBodySchema,
  LeadDtoSchema,
  LeadLostReasonSchema,
  LOST_REASONS_STALE_MESSAGE,
  lostReasonsToken,
} from '@bos/contracts';
import { leadLostReasons, leads } from '@bos/db';
import { type INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { CAN_KEY } from '../../platform/authz/decorators';
import { setTxObserver, txObserver } from '../../platform/db/tx-settings';
import { NumberingService } from '../../platform/settings/numbering.service';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadLostReasonsController } from './lost-reasons.controller';
import { LeadLostReasonsService } from './lost-reasons.service';
import { startHarness, type Harness } from './test/harness';
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import { SettingsService } from '../../platform/settings/settings.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let h: Harness;
let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  const audit = new AuditService(h.db);
  const reasons = new LeadLostReasonsService(h.db, audit, h.caller);
  const leadsService = new LeadsService(
    h.db,
    h.authz as unknown as AuthzService,
    audit,
    new NumberingService(),
    h.caller,
    new CurrencyEnabledService(new SettingsService(h.db)),
    reasons,
    h.roleCache,
    h.notify,
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [LeadsController, LeadLostReasonsController],
    providers: [
      { provide: LeadsService, useValue: leadsService },
      { provide: LeadLostReasonsService, useValue: reasons },
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

const BODY = {
  title: 'Website for Acme',
  source: 'referral',
  companyName: 'Acme Pvt. Ltd.',
  contactName: 'Sita Rai',
  country: 'NP',
  currency: 'USD',
  phones: [{ country: 'NP', e164: '+9779812345678', isPrimary: true }],
};

const dto = (body: unknown) => LeadDtoSchema.parse(body);
const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;
const options = LeadLostReasonSchema.array();

const seed = async () => {
  const res = await request(baseUrl).post('/v1/leads').send(BODY);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return dto(res.body);
};
const choices = async () => {
  const res = await request(baseUrl).get('/v1/lead-lost-reasons');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return options.parse(res.body);
};
const adminList = async () => {
  const res = await request(baseUrl).get('/v1/admin/lead-lost-reasons');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return options.parse(res.body);
};
const markLost = (id: string, version: number, pick: Record<string, unknown>) =>
  request(baseUrl)
    .patch(`/v1/leads/${id}/stage`)
    .send({ stage: 'lost', note: 'Went another way', expectedVersion: version, ...pick });
const getLead = async (id: string) => {
  const res = await request(baseUrl).get(`/v1/leads/${id}`);
  expect(res.status).toBe(200);
  return dto(res.body);
};
const labelOf = async (label: string) => {
  const found = (await adminList()).find((o) => o.label === label);
  expect(found, `option ${label}`).toBeDefined();
  return found!;
};

describe('D49 lost reasons: the list', () => {
  it('gives a tenant the seven defaults, in order, without retired options', async () => {
    const list = await choices();
    expect(list.map((o) => o.label)).toEqual(DEFAULT_LEAD_LOST_REASONS.map((d) => d.label));
    expect(list.map((o) => o.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(list.every((o) => o.isDefault && !o.retired)).toBe(true);
    const previous = txObserver();
    const wait = vi.fn();
    setTxObserver({ observeTx: vi.fn(), countDbBusy: vi.fn(), observeTenantLockWait: wait });
    try {
      expect(await choices()).toHaveLength(7);
      expect(wait).not.toHaveBeenCalled();
    } finally {
      setTxObserver(previous);
    }
  });

  it('is behind crm.lead.write for the dialog and admin.settings.write for the Settings card', () => {
    const reflector = new Reflector();
    const proto = LeadLostReasonsController.prototype;
    expect(reflector.get(CAN_KEY, proto.choices)).toBe('crm.lead.write');
    expect(reflector.get(CAN_KEY, proto.opportunityChoices)).toBe('crm.opportunity.write');
    for (const route of [proto.listAll, proto.create, proto.reorder, proto.reset, proto.update]) {
      expect(reflector.get(CAN_KEY, route)).toBe('admin.settings.write');
    }
  });
});

describe('D49 lost reasons: marking a lead lost', () => {
  it('stores a reference to the option, shows its label, and keeps the words beside it', async () => {
    const lead = await seed();
    const price = await labelOf('Price');
    const res = await markLost(lead.id, lead.version, { lostReasonId: price.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(dto(res.body)).toMatchObject({
      stage: 'lost',
      stageReason: 'Price',
      stageNote: 'Went another way',
      lostReason: { id: price.id, label: 'Price', retired: false },
    });
    const [row] = await h.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(row).toMatchObject({ lostReasonId: price.id, stageReason: 'Price' });
    const events = await h.auditOf(lead.id);
    expect(events.map((e) => e.action)).toContain('lead.stage_changed');
  });

  it('adds a new option from typed text (trimmed), offers it to everyone, and audits it', async () => {
    const lead = await seed();
    const res = await markLost(lead.id, lead.version, { newLostReason: '  Slow to reply  ' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = dto(res.body);
    expect(body.lostReason).toMatchObject({ label: 'Slow to reply', retired: false });
    expect(body.stageReason).toBe('Slow to reply');

    const list = await choices();
    expect(list.at(-1)).toMatchObject({ label: 'Slow to reply', isDefault: false, position: 7 });
    expect(list.find((o) => o.label === 'Slow to reply')!.id).toBe(body.lostReason!.id);
    const events = await h.auditOf(body.lostReason!.id);
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['lead_lost_reason.created']),
    );
    // The next lead picks it by id like any other option.
    const next = await seed();
    const again = await markLost(next.id, next.version, { lostReasonId: body.lostReason!.id });
    expect(dto(again.body).lostReason).toMatchObject({ label: 'Slow to reply' });
  });

  it('refuses a duplicate whatever its case or spacing, and leaves the lead as it was', async () => {
    const lead = await seed();
    for (const typed of ['price', ' PRICE ', 'Chose a  competitor'.replace('  ', ' ')]) {
      const res = await markLost(lead.id, lead.version, { newLostReason: typed });
      expect(res.status, typed).toBe(409);
      expect(errorOf(res.body).message).toContain('already on the list');
    }
    const after = await getLead(lead.id);
    expect(after).toMatchObject({ stage: 'new', lostReason: null, version: lead.version });
    const count = await h.db.select().from(leadLostReasons);
    expect(count.filter((o) => o.tenantId === h.tenantId && o.labelNorm === 'price')).toHaveLength(
      1,
    );
  });

  it('refuses an unknown option, a retired one, a missing choice, both choices, and the old free text', async () => {
    const lead = await seed();
    const timing = await labelOf('Timing');
    expect(
      (await markLost(lead.id, lead.version, { lostReasonId: crypto.randomUUID() })).status,
    ).toBe(400);
    expect((await markLost(lead.id, lead.version, {})).status).toBe(400);
    expect(
      (
        await markLost(lead.id, lead.version, {
          lostReasonId: timing.id,
          newLostReason: 'Something else',
        })
      ).status,
    ).toBe(400);
    expect((await markLost(lead.id, lead.version, { reason: 'price' })).status).toBe(400);
    expect((await getLead(lead.id)).stage).toBe('new');
  });

  it('keeps On Hold on its free-text reason: no option, no reference', async () => {
    const held = await seed();
    const res = await request(baseUrl).patch(`/v1/leads/${held.id}/stage`).send({
      stage: 'on_hold',
      reason: 'budget',
      note: 'next year',
      expectedVersion: held.version,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(dto(res.body)).toMatchObject({
      stage: 'on_hold',
      stageReason: 'budget',
      lostReason: null,
    });
    const sent = await request(baseUrl)
      .patch(`/v1/leads/${held.id}/stage`)
      .send({ stage: 'contacted', lostReasonId: crypto.randomUUID(), expectedVersion: 2 });
    expect(sent.status).toBe(400);
  });
});

describe('D49 lost reasons: retired and renamed options stay on old leads', () => {
  it('shows a retired option on the lead that has it, hides it from the choices, and refuses it for new leads', async () => {
    const lead = await seed();
    const timing = await labelOf('Timing');
    await markLost(lead.id, lead.version, { lostReasonId: timing.id });

    const retire = await request(baseUrl)
      .patch(`/v1/admin/lead-lost-reasons/${timing.id}`)
      .send({ retired: true, expectedVersion: timing.version });
    expect(retire.status, JSON.stringify(retire.body)).toBe(200);
    expect(LeadLostReasonSchema.parse(retire.body)).toMatchObject({ retired: true });

    // Old lead: still says Timing, flagged retired. List and detail agree.
    expect((await getLead(lead.id)).lostReason).toEqual({
      id: timing.id,
      label: 'Timing',
      retired: true,
    });
    const listed = await request(baseUrl).get('/v1/leads');
    const inList = (listed.body as unknown[]).map(dto).find((l) => l.id === lead.id);
    expect(inList?.lostReason).toMatchObject({ label: 'Timing', retired: true });

    // Not offered any more, but the Settings card still lists it so it can be restored.
    expect((await choices()).map((o) => o.label)).not.toContain('Timing');
    expect((await adminList()).find((o) => o.id === timing.id)).toMatchObject({ retired: true });

    const next = await seed();
    const refused = await markLost(next.id, next.version, { lostReasonId: timing.id });
    expect(refused.status).toBe(400);
    // Typing the retired words again is a duplicate too (one row per label), not a second option.
    expect((await markLost(next.id, next.version, { newLostReason: 'timing' })).status).toBe(409);

    const restored = await request(baseUrl)
      .patch(`/v1/admin/lead-lost-reasons/${timing.id}`)
      .send({ retired: false, expectedVersion: LeadLostReasonSchema.parse(retire.body).version });
    expect(LeadLostReasonSchema.parse(restored.body)).toMatchObject({ retired: false });
    expect((await choices()).map((o) => o.label)).toContain('Timing');
  });

  it('renames an option on every lead that carries it, and refuses a rename onto another label', async () => {
    const lead = await seed();
    const competitor = await labelOf('Chose a competitor');
    await markLost(lead.id, lead.version, { lostReasonId: competitor.id });

    const clash = await request(baseUrl)
      .patch(`/v1/admin/lead-lost-reasons/${competitor.id}`)
      .send({ label: ' no budget ', expectedVersion: competitor.version });
    expect(clash.status).toBe(409);

    const renamed = await request(baseUrl)
      .patch(`/v1/admin/lead-lost-reasons/${competitor.id}`)
      .send({ label: 'Went with a rival', expectedVersion: competitor.version });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect((await getLead(lead.id)).lostReason).toMatchObject({ label: 'Went with a rival' });
    // The stored words are the snapshot taken when the lead was lost.
    expect((await getLead(lead.id)).stageReason).toBe('Chose a competitor');

    const stale = await request(baseUrl)
      .patch(`/v1/admin/lead-lost-reasons/${competitor.id}`)
      .send({ label: 'Again', expectedVersion: competitor.version });
    expect(stale.status).toBe(409);
    expect(
      (
        await request(baseUrl)
          .patch(`/v1/admin/lead-lost-reasons/${crypto.randomUUID()}`)
          .send({ label: 'Nothing', expectedVersion: 1 })
      ).status,
    ).toBe(404);
  });
});

describe('D49 lost reasons: order and reset', () => {
  it('reorders the whole list, and refuses an order that leaves an option out', async () => {
    const before = await adminList();
    const reversed = [...before].reverse().map((o) => o.id);
    const res = await request(baseUrl)
      .put('/v1/admin/lead-lost-reasons/order')
      .send({ ids: reversed, expectedOrder: lostReasonsToken(before) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = options.parse(res.body);
    expect(after.map((o) => o.id)).toEqual(reversed);
    expect((await choices()).map((o) => o.id)).toEqual(
      reversed.filter((id) => before.find((o) => o.id === id && !o.retired)),
    );
    const partial = await request(baseUrl)
      .put('/v1/admin/lead-lost-reasons/order')
      .send({ ids: reversed.slice(1), expectedOrder: lostReasonsToken(after) });
    expect(partial.status).toBe(400);
  });

  it('resets to the defaults: labels, order and active state back, custom options retired after them', async () => {
    await request(baseUrl)
      .post('/v1/admin/lead-lost-reasons')
      .send({ label: 'Price' })
      .then((res) => {
        expect(res.status).toBe(409);
      });
    const added = await request(baseUrl)
      .post('/v1/admin/lead-lost-reasons')
      .send({ label: 'Out of stock' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const price = await labelOf('Price');
    const renamed = await request(baseUrl)
      .patch(`/v1/admin/lead-lost-reasons/${price.id}`)
      .send({ label: 'Cost', retired: true, expectedVersion: price.version });
    expect(renamed.status).toBe(200);
    // A custom option now takes the words Price once held.
    const taken = await request(baseUrl)
      .post('/v1/admin/lead-lost-reasons')
      .send({ label: 'Price' });
    expect(taken.status).toBe(201);

    const reset = await request(baseUrl)
      .post('/v1/admin/lead-lost-reasons/reset')
      .send({ expectedOrder: lostReasonsToken(await adminList()) });
    expect(reset.status, JSON.stringify(reset.body)).toBe(200);
    const list = options.parse(reset.body);
    expect(list.slice(0, 7).map((o) => o.label)).toEqual(
      DEFAULT_LEAD_LOST_REASONS.map((d) => d.label),
    );
    expect(list.slice(0, 7).every((o) => o.isDefault && !o.retired)).toBe(true);
    const custom = list.slice(7);
    expect(custom.every((o) => !o.isDefault && o.retired)).toBe(true);
    expect(custom.map((o) => o.label)).toEqual(
      expect.arrayContaining(['Out of stock', 'Price (custom)']),
    );
    // The retired custom option still shows on a lead that carries it (nothing was deleted).
    expect((await choices()).map((o) => o.label)).toEqual(
      DEFAULT_LEAD_LOST_REASONS.map((d) => d.label),
    );
    const events = await h.auditOf(h.tenantId);
    expect(events.map((e) => e.action)).toContain('lead_lost_reasons.reset');

    // A second round of the same clash finds "Price (custom)" taken and picks the next free label, not a 500.
    const price2 = await labelOf('Price');
    expect(
      (
        await request(baseUrl)
          .patch(`/v1/admin/lead-lost-reasons/${price2.id}`)
          .send({ label: 'Cost', expectedVersion: price2.version })
      ).status,
    ).toBe(200);
    expect(
      (await request(baseUrl).post('/v1/admin/lead-lost-reasons').send({ label: 'Price' })).status,
    ).toBe(201);
    const again = await request(baseUrl)
      .post('/v1/admin/lead-lost-reasons/reset')
      .send({ expectedOrder: lostReasonsToken(await adminList()) });
    expect(again.status, JSON.stringify(again.body)).toBe(200);
    const labels = options.parse(again.body).map((o) => o.label);
    expect(labels).toEqual(expect.arrayContaining(['Price (custom)', 'Price (custom 2)']));
    expect(new Set(labels.map((l) => l.toLowerCase())).size).toBe(labels.length);
  });

  it('gives two options added at the same moment two different positions', async () => {
    const sends = await Promise.all(
      ['Parallel add one', 'Parallel add two'].map((label) =>
        request(baseUrl).post('/v1/admin/lead-lost-reasons').send({ label }),
      ),
    );
    expect(sends.map((r) => r.status)).toEqual([201, 201]);
    const positions = (await adminList()).map((o) => o.position);
    expect(new Set(positions).size).toBe(positions.length);
  });
});

describe('D54-4 lost reasons: stale-view guard', () => {
  it('refuses reorder with a stale token (409) leaving the list unchanged, and accepts the current token', async () => {
    const initial = await adminList();
    const staleToken = lostReasonsToken(initial);

    // Another admin adds an option after the first screen loaded.
    const added = await request(baseUrl)
      .post('/v1/admin/lead-lost-reasons')
      .send({ label: 'Stale guard option' });
    expect(added.status, JSON.stringify(added.body)).toBe(201);
    const current = await adminList();

    // Even with the now-incomplete old id list, the stale token check runs first and returns 409 (not 400).
    const stale = await request(baseUrl)
      .put('/v1/admin/lead-lost-reasons/order')
      .send({ ids: [...initial].reverse().map((o) => o.id), expectedOrder: staleToken });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(errorOf(stale.body).message).toBe(LOST_REASONS_STALE_MESSAGE);
    expect((await adminList()).map((o) => o.id)).toEqual(current.map((o) => o.id));

    // Missing expectedOrder is a 400.
    expect(
      (
        await request(baseUrl)
          .put('/v1/admin/lead-lost-reasons/order')
          .send({ ids: current.map((o) => o.id) })
      ).status,
    ).toBe(400);

    // With the current token, reorder succeeds.
    const reversed = [...current].reverse().map((o) => o.id);
    const ok = await request(baseUrl)
      .put('/v1/admin/lead-lost-reasons/order')
      .send({ ids: reversed, expectedOrder: lostReasonsToken(current) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(options.parse(ok.body).map((o) => o.id)).toEqual(reversed);
  });

  it('refuses reset with a stale token (409) leaving the list unchanged, and accepts the current token', async () => {
    const before = await adminList();
    const staleToken = lostReasonsToken(before);
    const first = before[0]!;
    const renamed = await request(baseUrl)
      .patch(`/v1/admin/lead-lost-reasons/${first.id}`)
      .send({ label: `${first.label} edited`, expectedVersion: first.version });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    const afterRename = await adminList();

    // Missing expectedOrder is a 400.
    expect((await request(baseUrl).post('/v1/admin/lead-lost-reasons/reset').send({})).status).toBe(
      400,
    );

    const stale = await request(baseUrl)
      .post('/v1/admin/lead-lost-reasons/reset')
      .send({ expectedOrder: staleToken });
    expect(stale.status, JSON.stringify(stale.body)).toBe(409);
    expect(errorOf(stale.body).message).toBe(LOST_REASONS_STALE_MESSAGE);
    expect((await adminList()).map((o) => o.label)).toEqual(afterRename.map((o) => o.label));

    const ok = await request(baseUrl)
      .post('/v1/admin/lead-lost-reasons/reset')
      .send({ expectedOrder: lostReasonsToken(afterRename) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(
      options
        .parse(ok.body)
        .slice(0, 7)
        .map((o) => o.label),
    ).toEqual(DEFAULT_LEAD_LOST_REASONS.map((d) => d.label));
  });

  it('lets exactly one of two concurrent reorders with the same token win', async () => {
    const before = await adminList();
    const token = lostReasonsToken(before);
    const ids = before.map((o) => o.id);
    const orderA = [...ids].reverse();
    const orderB = [...ids.slice(1), ids[0]!];

    const [a, b] = await Promise.all([
      request(baseUrl)
        .put('/v1/admin/lead-lost-reasons/order')
        .send({ ids: orderA, expectedOrder: token }),
      request(baseUrl)
        .put('/v1/admin/lead-lost-reasons/order')
        .send({ ids: orderB, expectedOrder: token }),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? orderA : orderB;
    const loser = a.status === 409 ? a : b;
    expect(errorOf(loser.body).message).toBe(LOST_REASONS_STALE_MESSAGE);
    expect((await adminList()).map((o) => o.id)).toEqual(winner);
  });
});
