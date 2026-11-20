// Integration tests of the tax-code and payment-term Settings routes (F1-Q49) on a real Postgres (Testcontainers,
// needs Docker in WSL). Real: migrations (the no-overlap EXCLUDE, the audit triggers), MasterDataService,
// AuditService, the pricing reader loadTaxCodePeriods, and the controller behind the production body parser and
// error filter. Faked: the request context (scope and actor from the harness) and the grant check, which
// master-data.controller.test.ts covers.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/reference/master-data.integration.test.ts
import 'reflect-metadata';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  AdminPaymentTermSchema,
  AdminTaxCodeSchema,
  ErrorBodySchema,
  PaymentTermSchema,
  TaxCodeSchema,
} from '@bos/contracts';
import { resolveTaxCode } from '@bos/money-rules';
import { taxCodes } from '@bos/db';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../../app.setup';
import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { ErrorBodyFilter } from '../../../platform/tenancy/error-body.filter';
import { startHarness, type Harness } from '../../leads/test/harness';
import { loadTaxCodePeriods } from '../pricing/tax-codes.resolver';
import type { MasterDataCaller } from './master-data.caller';
import { MasterDataController } from './master-data.controller';
import { MasterDataService } from './master-data.service';
import { ReferenceController } from './reference.controller';
import { ReferenceService } from './reference.service';
import { kathmanduDay } from './reference.types';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let h: Harness;
let app: INestApplication;
let baseUrl: string;

const shift = (day: string, delta: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};
const today = kathmanduDay(new Date());

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  h.as('boss', 'founder');
  const caller = {
    current: () => {
      const { scope, actor } = h.caller.current();
      return { scope, actor };
    },
    assertEditor: () => undefined,
  } as unknown as MasterDataCaller;
  const masterData = new MasterDataService(h.db, new AuditService(h.db), caller);
  const reference = new ReferenceService(h.db, { tenantId: () => h.tenantId }, {
    assert: () => undefined,
  } as unknown as AuthzService);
  const moduleRef = await Test.createTestingModule({
    controllers: [MasterDataController, ReferenceController],
    providers: [
      { provide: MasterDataService, useValue: masterData },
      { provide: ReferenceService, useValue: reference },
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

const code = (body: unknown) => AdminTaxCodeSchema.parse(body);

describe('tax codes', () => {
  it('adds a code from today that the quotation form offers at once', async () => {
    const res = await request(baseUrl).post('/v1/admin/tax-codes').send({
      code: 'WP4VAT',
      name: 'VAT 13%',
      kind: 'vat',
      rate: '13',
      creditable: true,
      effectiveFrom: today,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(code(res.body)).toMatchObject({ code: 'WP4VAT', current: { rate: '13' }, endsOn: null });
    const offered = z
      .array(TaxCodeSchema)
      .parse((await request(baseUrl).get('/v1/tax-codes')).body);
    expect(offered.map((t) => t.code)).toContain('WP4VAT');
  });

  it('refuses the same code twice, and a start before today', async () => {
    const again = await request(baseUrl)
      .post('/v1/admin/tax-codes')
      .send({
        code: 'WP4VAT',
        name: 'Again',
        kind: 'vat',
        rate: '10',
        creditable: true,
        effectiveFrom: shift(today, 3),
      });
    expect(again.status).toBe(409);
    expect(ErrorBodySchema.parse(again.body).error.message).toContain('already exists');
    const early = await request(baseUrl)
      .post('/v1/admin/tax-codes')
      .send({
        code: 'WP4OLD',
        name: 'Old',
        kind: 'vat',
        rate: '10',
        creditable: true,
        effectiveFrom: shift(today, -1),
      });
    expect(early.status).toBe(400);
  });

  it('changes the rate forward only: the old period keeps its rate and pricing picks by issue day', async () => {
    const list = z
      .array(AdminTaxCodeSchema)
      .parse((await request(baseUrl).get('/v1/admin/tax-codes')).body);
    const before = list.find((c) => c.code === 'WP4VAT')!;
    const from = shift(today, 10);

    const stale = await request(baseUrl).post('/v1/admin/tax-codes/WP4VAT/changes').send({
      name: 'VAT 15%',
      rate: '15',
      creditable: true,
      effectiveFrom: from,
      expectedVersion: 99,
    });
    expect(stale.status).toBe(409);

    const res = await request(baseUrl).post('/v1/admin/tax-codes/WP4VAT/changes').send({
      name: 'VAT 15%',
      rate: '15',
      creditable: true,
      effectiveFrom: from,
      expectedVersion: before.latest.version,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const after = code(res.body);
    expect(after.periods.map((p) => [p.rate, p.effectiveFrom, p.effectiveTo])).toEqual([
      ['13', today, from],
      ['15', from, null],
    ]);
    expect(after.current?.id).toBe(before.latest.id);
    expect(after.next?.rate).toBe('15');

    // The row an issued document names keeps its rate (bills, orders and sourcing read rate_bp by id).
    const [kept] = await h.db
      .select({ rateBp: taxCodes.rateBp })
      .from(taxCodes)
      .where(and(eq(taxCodes.tenantId, h.tenantId), eq(taxCodes.id, before.latest.id)));
    expect(kept?.rateBp).toBe(1300);

    // Quotation pricing loads every period of the code and picks the one in force on the issue day.
    const periods = await loadTaxCodePeriods(h.db, h.tenantId, [before.latest.id]);
    const asPricing = periods.map((p) => ({
      code: p.code,
      kind: p.kind,
      rateBp: p.rateBp,
      creditable: p.creditable,
      effectiveFrom: p.effectiveFrom,
      effectiveTo: p.effectiveTo,
    }));
    expect(resolveTaxCode(asPricing, 'WP4VAT', shift(from, -1)).rateBp).toBe(1300);
    expect(resolveTaxCode(asPricing, 'WP4VAT', from).rateBp).toBe(1500);
  });

  it('retires a code: not offered from that day, and no further change', async () => {
    const list = z
      .array(AdminTaxCodeSchema)
      .parse((await request(baseUrl).get('/v1/admin/tax-codes')).body);
    const current = list.find((c) => c.code === 'WP4VAT')!;
    const retireOn = shift(today, 20);
    const res = await request(baseUrl)
      .post('/v1/admin/tax-codes/WP4VAT/retire')
      .send({ effectiveTo: retireOn, expectedVersion: current.latest.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(code(res.body).endsOn).toBe(retireOn);

    const change = await request(baseUrl)
      .post('/v1/admin/tax-codes/WP4VAT/changes')
      .send({
        name: 'VAT 16%',
        rate: '16',
        creditable: true,
        effectiveFrom: shift(today, 30),
        expectedVersion: code(res.body).latest.version,
      });
    expect(change.status).toBe(409);
  });

  it('answers 404 for a code the tenant does not have', async () => {
    const res = await request(baseUrl)
      .post('/v1/admin/tax-codes/NOPE/retire')
      .send({ effectiveTo: shift(today, 5), expectedVersion: 1 });
    expect(res.status).toBe(404);
  });
});

describe('payment terms', () => {
  it('adds, renames, retires and restores a term; the quotation form follows', async () => {
    const created = await request(baseUrl)
      .post('/v1/admin/payment-terms')
      .send({ code: 'WP4NET45', name: 'Net 45', netDays: 45 });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const term = AdminPaymentTermSchema.parse(created.body);
    expect(term).toMatchObject({ netDays: 45, retired: false, version: 1 });

    const dupe = await request(baseUrl)
      .post('/v1/admin/payment-terms')
      .send({ code: 'WP4NET45B', name: ' net 45 ', netDays: 45 });
    expect(dupe.status).toBe(409);

    const renamed = await request(baseUrl)
      .patch(`/v1/admin/payment-terms/${term.id}`)
      .send({ name: 'Net 45 days', expectedVersion: 1 });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(AdminPaymentTermSchema.parse(renamed.body)).toMatchObject({
      name: 'Net 45 days',
      netDays: 45,
    });

    const stale = await request(baseUrl)
      .patch(`/v1/admin/payment-terms/${term.id}`)
      .send({ retired: true, expectedVersion: 1 });
    expect(stale.status).toBe(409);

    const retired = await request(baseUrl)
      .patch(`/v1/admin/payment-terms/${term.id}`)
      .send({ retired: true, expectedVersion: 2 });
    expect(retired.status).toBe(200);
    const offered = z
      .array(PaymentTermSchema)
      .parse((await request(baseUrl).get('/v1/payment-terms')).body);
    expect(offered.map((t) => t.id)).not.toContain(term.id);
    const all = z
      .array(AdminPaymentTermSchema)
      .parse((await request(baseUrl).get('/v1/admin/payment-terms')).body);
    expect(all.find((t) => t.id === term.id)?.retired).toBe(true);

    const restored = await request(baseUrl)
      .patch(`/v1/admin/payment-terms/${term.id}`)
      .send({ retired: false, expectedVersion: 3 });
    expect(restored.status).toBe(200);
  });
});
