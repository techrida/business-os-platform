// Unit tests of the D44 currency check on a lead's create and edit, with a fake database (no Docker).
// Run with: pnpm --filter @bos/api exec vitest run src/modules/leads/leads.currency.test.ts
//
// The real LeadsService methods run against a fake transaction that records the LD numbers issued and the rows
// inserted or updated. The currency side is real too: CurrencyEnabledService over SettingsService, whose
// `currency.enabled` read answers a saved list when the test gives one, otherwise no rows, so the default list
// comes from the contract's SETTING_DEFAULTS. Bodies are parsed with the real contract schemas, so a create that
// leaves the currency out gets the contract's NPR default, as the workspace form does.
import 'reflect-metadata';

import { CreateLeadBodySchema, UpdateLeadBodySchema } from '@bos/contracts';
import { UnprocessableEntityException } from '@nestjs/common';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import type { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import type { RoleCache } from '../../platform/authz/role-cache';
import type { Db } from '../../platform/db/db.module';
import type { NotifyService } from '../../platform/notify/notify.service';
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import type { NumberingService } from '../../platform/settings/numbering.service';
import { SettingsService } from '../../platform/settings/settings.service';
import type { LeadsCaller } from './leads.caller';
import { LeadsService } from './leads.service';
import type { LeadLostReasonsService } from './lost-reasons.service';
import type { LeadRow } from './leads.types';

const TENANT = '0a000000-0000-4000-8000-000000000001';
const ENTITY = '0a000000-0000-4000-8000-000000000002';
const USER = '0a000000-0000-4000-8000-000000000009';
const LEAD_ID = '3d000000-0000-4000-8000-000000000001';
const scope = { tenantId: TENANT, organizationId: ENTITY };
const dialect = new PgDialect();

/** A stored lead in USD; `over` changes single columns. */
function leadRow(over: Partial<LeadRow> = {}): LeadRow {
  const at = new Date('2026-11-01T00:00:00Z');
  return {
    id: LEAD_ID,
    tenantId: TENANT,
    organizationId: ENTITY,
    departmentId: null,
    number: 'LD-2083/84-00001',
    title: 'Website for Acme',
    source: 'referral',
    campaign: null,
    ownerUserId: USER,
    companyName: 'Acme Pvt. Ltd.',
    contactName: 'Sita Rai',
    country: 'NP',
    emailNorm: 'sita@acme.example',
    phonesSearch: null,
    customerId: null,
    contactId: null,
    requirement: null,
    expectedValue: '1000.00',
    currency: 'USD',
    probability: null,
    expectedClose: null,
    nextFollowUpAt: null,
    notes: null,
    stage: 'new',
    stageReason: null,
    stageNote: null,
    lostReasonId: null,
    heldFromStage: null,
    createdByUserId: null,
    convertedOpportunityId: null,
    version: 1,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

/**
 * A LeadsService over fakes. `saved` is the company's saved `currency.enabled` list (null: nothing saved);
 * `stored` is the lead row an edit locks. The returned record counts settings reads, LD numbers issued and the
 * values inserted or set.
 */
function serviceWith(saved: readonly string[] | null, stored: LeadRow = leadRow()) {
  const seen = {
    settingsReads: 0,
    issued: 0,
    inserted: [] as Record<string, unknown>[],
    updated: [] as Record<string, unknown>[],
  };
  // withTx's set_config, updateVersioned's scope read: both answer the transaction's scope and actor.
  const tx = {
    execute: () =>
      Promise.resolve({
        rows: [{ tenant_id: TENANT, organization_id: ENTITY, actor_id: USER }],
      }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        seen.inserted.push(values);
        return {
          returning: () => Promise.resolve([{ ...leadRow(), ...values, id: LEAD_ID, version: 1 }]),
        };
      },
    }),
    // replaceLeadPhones clears the lead's numbers before writing the new set.
    delete: () => ({ where: () => Promise.resolve() }),
    update: () => ({
      set: (set: Record<string, unknown>) => {
        seen.updated.push(set);
        return {
          where: () => ({
            returning: () => Promise.resolve([{ ...stored, ...set, version: stored.version + 1 }]),
          }),
        };
      },
    }),
    // select() is the locked row read; select({ nextFollowUp }) is the derived follow-up, none planned here; an
    // ordered select is the lead's phone numbers, none stored here.
    select: (fields?: unknown) => ({
      from: () => ({
        where: () => {
          const rows = fields === undefined ? [stored] : [{ nextFollowUp: null }];
          return Object.assign(Promise.resolve(rows), {
            for: () => Promise.resolve(rows),
            orderBy: () => Promise.resolve([]),
          });
        },
      }),
    }),
  };
  const db = {
    transaction: (fn: (t: unknown) => Promise<unknown>) => fn(tx),
    // SettingsService reads outside the transaction, on the pool.
    execute: (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
      const { sql: text } = dialect.sqlToQuery(query);
      if (!text.includes('FROM app.settings')) throw new Error(`unexpected query: ${text}`);
      seen.settingsReads += 1;
      return Promise.resolve({ rows: saved ? [{ version: 2, value: saved }] : [] });
    },
  } as unknown as Db;
  const principal = {
    userId: USER,
    roles: ['sales'],
    departmentId: null,
    grants: new Map([
      ['crm.lead.read', 'own'],
      ['crm.lead.write', 'own'],
    ]),
  } as unknown as Principal;
  const caller = {
    current: () => ({
      scope,
      actor: { kind: 'user', id: USER, correlationId: 'test-correlation-id' },
      principal,
    }),
  } as unknown as LeadsCaller;
  const authz = { assert: () => undefined } as unknown as AuthzService;
  const audit = { record: () => Promise.resolve() } as unknown as AuditService;
  const numbering = {
    issue: () => {
      seen.issued += 1;
      return Promise.resolve({ number: 'LD-2083/84-00002', seq: 2, fiscalYear: '2083/84' });
    },
  } as unknown as NumberingService;
  const service = new LeadsService(
    db,
    authz,
    audit,
    numbering,
    caller,
    new CurrencyEnabledService(new SettingsService(db)),
    {} as LeadLostReasonsService,
    {} as RoleCache,
    {} as NotifyService,
  );
  return { service, seen };
}

const NEW_LEAD = {
  title: 'Website for Acme',
  source: 'referral',
  companyName: 'Acme Pvt. Ltd.',
  contactName: 'Sita Rai',
  country: 'NP',
  email: 'sita@acme.example',
};

/** Runs `fn` and returns what it threw. */
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

function expectNotEnabled(error: unknown, currency: string): void {
  expect(error).toBeInstanceOf(UnprocessableEntityException);
  expect((error as UnprocessableEntityException).getResponse()).toEqual({
    code: 'CURRENCY_NOT_ENABLED',
    message: `Currency ${currency} is not enabled for this company`,
    details: { currency },
  });
}

describe('LeadsService.create: the currency must be switched on (D44)', () => {
  it('refuses a currency the company switched off, before an LD number is taken or a row written', async () => {
    const { service, seen } = serviceWith(['NPR', 'USD']);
    const body = CreateLeadBodySchema.parse({ ...NEW_LEAD, currency: 'INR' });
    // Fails on the old code: create had no check, so it resolved with the INR lead instead of throwing.
    expectNotEnabled(await caught(() => service.create(body)), 'INR');
    expect(seen.issued).toBe(0);
    expect(seen.inserted).toEqual([]);
  });

  it('accepts a currency in the default list when nothing is saved', async () => {
    const { service, seen } = serviceWith(null);
    const body = CreateLeadBodySchema.parse({ ...NEW_LEAD, currency: 'USD' });
    const lead = await service.create(body);
    expect(lead.currency).toBe('USD');
    expect(seen.settingsReads).toBe(1);
    expect(seen.inserted).toHaveLength(1);
    expect(seen.inserted[0]).toMatchObject({ currency: 'USD' });
  });

  it('accepts a create that leaves the currency out (contract default NPR) without reading the setting', async () => {
    const { service, seen } = serviceWith(['USD']);
    const lead = await service.create(CreateLeadBodySchema.parse(NEW_LEAD));
    expect(lead.currency).toBe('NPR');
    expect(seen.settingsReads).toBe(0);
    expect(seen.issued).toBe(1);
  });
});

describe('LeadsService.update: a changed currency must be switched on (D44)', () => {
  it('refuses a change to a currency the company switched off, and sets nothing', async () => {
    const { service, seen } = serviceWith(['NPR', 'USD']);
    const body = UpdateLeadBodySchema.parse({ currency: 'INR', expectedVersion: 1 });
    // Fails on the old code: the edit was saved (resolved with currency INR) instead of a 422.
    expectNotEnabled(await caught(() => service.update(LEAD_ID, body)), 'INR');
    expect(seen.updated).toEqual([]);
  });

  it('lets other fields change on a lead whose currency was switched off later', async () => {
    // The lead is in USD; the company now allows only NPR. Resending the same currency is not a change.
    const { service, seen } = serviceWith(['NPR']);
    const body = UpdateLeadBodySchema.parse({
      title: 'Website and app for Acme',
      currency: 'USD',
      expectedVersion: 1,
    });
    const lead = await service.update(LEAD_ID, body);
    expect(lead.title).toBe('Website and app for Acme');
    expect(lead.currency).toBe('USD');
    expect(seen.settingsReads).toBe(0);
    expect(seen.updated).toHaveLength(1);
    expect(seen.updated[0]).not.toHaveProperty('currency');
  });

  it('lets other fields change on a lead with no currency', async () => {
    const { service, seen } = serviceWith(['NPR'], leadRow({ currency: null } as never));
    const body = UpdateLeadBodySchema.parse({ title: 'Renamed', expectedVersion: 1 });
    const lead = await service.update(LEAD_ID, body);
    expect(lead.currency).toBeNull();
    expect(seen.settingsReads).toBe(0);
    expect(seen.updated).toHaveLength(1);
  });

  it('accepts a change to a currency in the default list when nothing is saved', async () => {
    const { service, seen } = serviceWith(null);
    const body = UpdateLeadBodySchema.parse({ currency: 'INR', expectedVersion: 1 });
    const lead = await service.update(LEAD_ID, body);
    expect(lead.currency).toBe('INR');
    expect(seen.settingsReads).toBe(1);
    expect(seen.updated[0]).toMatchObject({ currency: 'INR' });
  });
});
