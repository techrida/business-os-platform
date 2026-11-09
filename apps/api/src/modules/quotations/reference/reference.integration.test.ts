// Integration tests of the reference routes on a real Postgres (Testcontainers, needs Docker in WSL). Real:
// migrations, ReferenceService, the controller behind the production body parser and error filter. Faked: the
// request context (ReferenceCaller names the tenant). Responses are parsed with the contract schemas the
// quotation form uses.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/reference
import 'reflect-metadata';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { PaymentTermSchema, TaxCodeSchema } from '@bos/contracts';
import { createTenantWithEntity, paymentTerms, taxCodes } from '@bos/db';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../../app.setup';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { systemActor, withTx } from '../../../platform/db/tx';
import { ErrorBodyFilter } from '../../../platform/tenancy/error-body.filter';
import { startHarness, type EntityScope, type Harness } from '../../leads/test/harness';
import type { ReferenceCaller } from './reference.caller';
import { ReferenceController } from './reference.controller';
import { ReferenceService } from './reference.service';
import { kathmanduDay } from './reference.types';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let h: Harness;
let app: INestApplication;
let baseUrl: string;
let scopeB: EntityScope;
/** The tenant the fake request store names; a test switches it to read as the other tenant. */
let actingTenant = '';

/** `day` (YYYY-MM-DD) moved by `delta` days. */
const shift = (day: string, delta: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
};
const today = kathmanduDay(new Date());

const taxRow = (
  scope: EntityScope,
  code: string,
  kind: 'vat' | 'exempt' | 'zero',
  rateBp: number,
  from: string,
  to: string | null,
) => ({
  tenantId: scope.tenantId,
  code,
  name: `${code} name`,
  kind,
  rateBp,
  creditable: kind === 'vat',
  effectiveFrom: from,
  effectiveTo: to,
});

const termRow = (scope: EntityScope, code: string, netDays: number, isActive = true) => ({
  tenantId: scope.tenantId,
  code,
  name: `${code} name`,
  netDays,
  isActive,
});

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  actingTenant = h.tenantId;
  const other = await createTenantWithEntity(
    h.appPool as unknown as Parameters<typeof createTenantWithEntity>[0],
  );
  scopeB = { tenantId: other.tenantId, organizationId: other.organizationId };

  await withTx(h.db, h.scopeA, systemActor('test'), async (tx) => {
    await tx.insert(taxCodes).values([
      // VAT13 has three periods: only the middle one is in force today.
      taxRow(h.scopeA, 'VAT13', 'vat', 1000, shift(today, -400), shift(today, -10)),
      taxRow(h.scopeA, 'VAT13', 'vat', 1300, shift(today, -10), shift(today, 10)),
      taxRow(h.scopeA, 'VAT13', 'vat', 1500, shift(today, 10), null),
      // Open-ended from yesterday, and one that starts today (the first day counts).
      taxRow(h.scopeA, 'EXEMPT', 'exempt', 0, shift(today, -1), null),
      taxRow(h.scopeA, 'ZERO', 'zero', 0, today, null),
      // Ends today (effectiveTo is exclusive: not in force) and starts tomorrow: neither is returned.
      taxRow(h.scopeA, 'ENDED', 'vat', 500, shift(today, -30), today),
      taxRow(h.scopeA, 'FUTURE', 'vat', 700, shift(today, 1), null),
    ]);
    await tx
      .insert(paymentTerms)
      .values([
        termRow(h.scopeA, 'NET30', 30),
        termRow(h.scopeA, 'ADVANCE', 0),
        termRow(h.scopeA, 'OLD60', 60, false),
      ]);
  });
  await withTx(h.db, scopeB, systemActor('test'), async (tx) => {
    await tx
      .insert(taxCodes)
      .values([
        taxRow(scopeB, 'OTHERONLY', 'vat', 1300, shift(today, -5), null),
        taxRow(scopeB, 'VAT13', 'vat', 900, shift(today, -5), null),
      ]);
    await tx.insert(paymentTerms).values([termRow(scopeB, 'NET99', 99)]);
  });

  const caller: ReferenceCaller = { tenantId: () => actingTenant };
  // The grant is covered by reference.service.test.ts; here the caller is allowed so the read itself is tested.
  const authz = { assert: () => undefined } as unknown as AuthzService;
  const service = new ReferenceService(h.db, caller, authz);
  const moduleRef = await Test.createTestingModule({
    controllers: [ReferenceController],
    providers: [{ provide: ReferenceService, useValue: service }],
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
  actingTenant = h.tenantId;
});

const taxCodesNow = async () =>
  z.array(TaxCodeSchema).parse((await request(baseUrl).get('/v1/tax-codes')).body);
const termsNow = async () =>
  z.array(PaymentTermSchema).parse((await request(baseUrl).get('/v1/payment-terms')).body);

describe('GET /v1/tax-codes', () => {
  it('returns only the periods in force today, one per code, as TaxCodeSchema', async () => {
    const res = await request(baseUrl).get('/v1/tax-codes');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const list = z.array(TaxCodeSchema).parse(res.body);
    expect(list.map((t) => t.code)).toEqual(['EXEMPT', 'VAT13', 'ZERO']);
    expect(list.find((t) => t.code === 'VAT13')).toMatchObject({
      label: 'VAT13 name',
      rate: '13',
      kind: 'vat',
      rateBp: 1300,
    });
    expect(list.find((t) => t.code === 'ZERO')).toMatchObject({
      rate: '0',
      kind: 'zero',
      rateBp: 0,
    });
  });

  it("does not return another tenant's codes, and reads that tenant's own", async () => {
    const mine = await taxCodesNow();
    expect(mine.map((t) => t.code)).not.toContain('OTHERONLY');
    expect(mine.find((t) => t.code === 'VAT13')?.rateBp).toBe(1300);

    actingTenant = scopeB.tenantId;
    const theirs = await taxCodesNow();
    expect(theirs.map((t) => t.code)).toEqual(['OTHERONLY', 'VAT13']);
    expect(theirs.find((t) => t.code === 'VAT13')?.rateBp).toBe(900);
  });
});

describe('GET /v1/payment-terms', () => {
  it('returns the active terms, shortest first, and hides the inactive one', async () => {
    const res = await request(baseUrl).get('/v1/payment-terms');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const list = z.array(PaymentTermSchema).parse(res.body);
    expect(list.map((t) => t.label)).toEqual(['ADVANCE name', 'NET30 name']);
  });

  it("does not return another tenant's terms", async () => {
    expect((await termsNow()).map((t) => t.label)).not.toContain('NET99 name');

    actingTenant = scopeB.tenantId;
    expect((await termsNow()).map((t) => t.label)).toEqual(['NET99 name']);
  });
});
