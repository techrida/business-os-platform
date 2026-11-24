// Integration test of promises to pay (F1-Q33) on a real Postgres (Testcontainers, needs Docker in WSL). Run with:
//   pnpm --filter @bos/api exec vitest run src/modules/receivables/promises/payment-promises.integration.test.ts
//
// One chain, as the people involved: an Accountant records a promise through PaymentPromisesService; the hourly job
// (the real drizzle store and withTx) runs after the promised day; Finance finds the collection call on the
// Follow-ups list (ActivitiesService) and completes it, and sees the customer flagged on the receivables aging
// (ReceivablesService); a second run plans nothing more. Real: migrations, every query as bos_app, the audit trail,
// the RoleCache and the pure can() on the acting principal (../../leads/test/harness.ts). Seeded directly: the issued
// invoice and its debit open item, written the way invoice issue writes them.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  ActivityDtoSchema,
  ArAgingReportSchema,
  PaymentPromiseDtoSchema,
  PaymentPromiseListSchema,
  type RecordPaymentPromiseBody,
} from '@bos/contracts';
import { activities, paymentPromises } from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { ActivitiesService } from '../../activities/activities.service';
import { ListActivitiesQuerySchema } from '../../activities/activities.types';
import { startHarness, type Harness } from '../../leads/test/harness';
import { LedgerService } from '../../ledger/ledger.service';
import { ReceivablesService } from '../receivables.service';
import { drizzlePromiseStore, PaymentPromiseSweeper } from './payment-promise.sweeper';
import { PaymentPromisesService } from './payment-promises.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/** 11:45 in Kathmandu on 2026-11-09, when the promise is recorded. */
const RECORDED_AT = new Date('2026-11-09T06:00:00Z');
/** 11:45 in Kathmandu on 2026-11-12, two days after the promised day. */
const SWEPT_AT = new Date('2026-11-12T06:00:00Z');
const PROMISED = '2026-11-10';

let h: Harness;
let promises: PaymentPromisesService;
let sweeper: PaymentPromiseSweeper;
let followUps: ActivitiesService;
let receivables: ReceivablesService;
let accountant: string;
let finance: string;
let customer: string;
const ledger = new LedgerService();
const system = systemActor('payment-promise-test');
let nextSeq = 1;

/** An issued NPR tax invoice of `total` for `customerId` in `scope`, with its debit open item (due 2026-12-01). */
async function issuedInvoice(scope: TxScope, customerId: string, total: string): Promise<string> {
  return withTx(h.db, scope, system, async (tx) => {
    const inserted = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.invoices
            (tenant_id, organization_id, kind, customer_party_id, manual_reason, currency, subtotal,
             discount_amount, taxable_vat_amount, tax_amount, total)
          VALUES (${scope.tenantId}, ${scope.organizationId}, 'tax_invoice', ${customerId}, 'One-off sale', 'NPR',
                  ${total}, 0, ${total}, 0, ${total})
          RETURNING id`,
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('invoice insert returned no row');
    const seq = nextSeq++;
    await tx.execute(
      sql`UPDATE app.invoices
             SET status = 'issued', number = ${`INV-2083/84-${String(seq).padStart(5, '0')}`}, seq = ${seq},
                 fiscal_year = '2083/84', issue_date = '2026-11-01', issue_date_bs = '2083-07-15',
                 due_date = '2026-12-01', fx_rate = 1, amount_npr = total,
                 seller_snapshot = '{"name": "Techrida Pvt. Ltd."}', buyer_snapshot = '{"name": "Acme"}',
                 content_hash = decode(repeat('ab', 32), 'hex'), issued_at = now()
           WHERE id = ${id}`,
    );
    await ledger.openItem(tx, scope, system, {
      side: 'receivable',
      direction: 'debit',
      partyId: customerId,
      sourceType: 'tax_invoice',
      sourceId: id,
      currency: 'NPR',
      amount: total,
      amountNpr: total,
      fxRate: '1',
      documentDate: '2026-11-01',
      dueDate: '2026-12-01',
    });
    return id;
  });
}

const record = (invoiceId: string, body: RecordPaymentPromiseBody, key = randomUUID()) => {
  const { scope, actor } = h.caller.current();
  return promises.record(scope, actor, invoiceId, body, key);
};

const list = (invoiceId: string) => {
  const { scope, actor } = h.caller.current();
  return promises.list(scope, actor, invoiceId).then((r) => PaymentPromiseListSchema.parse(r));
};

/** A draft NPR tax invoice of `total` for `customerId`: no number, no open item, so it takes no promise. */
async function draftInvoice(scope: TxScope, customerId: string, total: string): Promise<string> {
  return withTx(h.db, scope, system, async (tx) => {
    const inserted = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.invoices
            (tenant_id, organization_id, kind, customer_party_id, manual_reason, currency, subtotal,
             discount_amount, taxable_vat_amount, tax_amount, total)
          VALUES (${scope.tenantId}, ${scope.organizationId}, 'tax_invoice', ${customerId}, 'One-off sale', 'NPR',
                  ${total}, 0, ${total}, 0, ${total})
          RETURNING id`,
    );
    const id = inserted.rows[0]?.id;
    if (id === undefined) throw new Error('invoice insert returned no row');
    return id;
  });
}

const callsOn = (customerId: string) =>
  withTx(h.db, h.scopeA, system, (tx) =>
    tx
      .select()
      .from(activities)
      .where(and(eq(activities.tenantId, h.tenantId), eq(activities.customerId, customerId))),
  );

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  const authz = h.authz as unknown as AuthzService;
  const audit = new AuditService(h.db);
  promises = new PaymentPromisesService(h.db, authz, audit, () => RECORDED_AT);
  sweeper = new PaymentPromiseSweeper(
    drizzlePromiseStore(h.db),
    (scope, actor, fn) => withTx(h.db, scope, actor, fn),
    audit,
    () => SWEPT_AT,
    h.notify,
  );
  followUps = new ActivitiesService(h.db, authz, audit, h.caller, h.roleCache, h.notify);
  receivables = new ReceivablesService(h.db, authz, () => SWEPT_AT);
  accountant = await h.member({ roles: ['accountant'], displayName: 'Asha Accountant' });
  finance = await h.member({ roles: ['finance'], displayName: 'Bina Finance' });
  customer = await h.seedCustomer();
});

afterAll(async () => {
  await h?.stop();
});

describe('a missed promise to pay (F1-Q33)', () => {
  it('records, misses, plans one call for Finance, flags the aging, and plans nothing more on a second run', async () => {
    const invoice = await issuedInvoice(h.scopeA, customer, '50000.00');

    // The Accountant records the promise; the same key replays it.
    await h.actAs(accountant);
    const key = randomUUID();
    const promise = PaymentPromiseDtoSchema.parse(
      await record(invoice, { promisedDate: PROMISED, note: 'Pays after the board meets' }, key),
    );
    expect(promise).toMatchObject({
      invoiceId: invoice,
      promisedDate: PROMISED,
      status: 'open',
      recordedByUserId: accountant,
      missedAt: null,
      collectionActivityId: null,
    });
    await expect(
      record(invoice, { promisedDate: PROMISED, note: 'Pays after the board meets' }, key),
    ).resolves.toEqual(promise);

    // Before the day has passed the job leaves it alone.
    const early = new PaymentPromiseSweeper(
      drizzlePromiseStore(h.db),
      (scope, actor, fn) => withTx(h.db, scope, actor, fn),
      new AuditService(h.db),
      () => new Date('2026-11-10T12:00:00Z'),
      h.notify,
    );
    await expect(early.sweep()).resolves.toMatchObject({ missed: 0, kept: 0 });

    // After it, the job marks the promise missed and plans the collection call for Finance.
    await expect(sweeper.sweep()).resolves.toEqual({ missed: 1, kept: 0, skipped: 0, failed: 0 });
    const [stored] = await withTx(h.db, h.scopeA, system, (tx) =>
      tx.select().from(paymentPromises).where(eq(paymentPromises.id, promise.id)),
    );
    expect(stored).toMatchObject({ status: 'missed', missedAt: SWEPT_AT });
    expect(stored?.collectionActivityId).toEqual(expect.any(String));

    // The call's assignee has one bell notice for it (OQ-30, R6Q22): no email, a link to the Follow-ups page, and the
    // call's id in the dedupe key.
    const bell = await h.ownerPool.query(
      `SELECT user_id, title, link FROM app.notifications WHERE tenant_id = $1 AND dedupe_key = $2`,
      [h.tenantId, `collection_call.planned:${stored?.collectionActivityId}`],
    );
    expect(bell.rows as unknown[]).toEqual([
      {
        user_id: finance,
        title: expect.stringMatching(/^Collect payment for INV-/) as string,
        link: '/activities/',
      },
    ]);
    const mail = await h.ownerPool.query(
      `SELECT 1 FROM app.outbox WHERE tenant_id = $1 AND dedupe_key LIKE 'collection_call.planned:%'`,
      [h.tenantId],
    );
    expect(mail.rows).toHaveLength(0);

    // Finance finds it on the Follow-ups list (planned, assigned to them) and completes it.
    await h.actAs(finance);
    const planned = z
      .array(ActivityDtoSchema)
      .parse((await followUps.list(ListActivitiesQuerySchema.parse({ status: 'planned' }))).items);
    const call = planned.find((a) => a.id === stored?.collectionActivityId);
    expect(call).toMatchObject({
      kind: 'collection_call',
      subject: expect.stringMatching(/^Collect payment for INV-2083\/84-\d{5}$/) as string,
      customerId: customer,
      assigneeUserId: finance,
    });
    if (call === undefined) throw new Error('the collection call is not on the Follow-ups list');
    expect(call.body).toContain(`by ${PROMISED}`);
    expect(call.body).not.toContain('Pays after the board meets');
    const done = ActivityDtoSchema.parse(
      await followUps.complete(call.id, { expectedVersion: 1, note: 'Customer pays Friday' }),
    );
    expect(done.completedAt).not.toBeNull();

    // The aging flags the customer in NPR with the promised day.
    const aging = ArAgingReportSchema.parse(await receivables.aging(h.scopeA));
    expect(aging.rows.find((r) => r.customerId === customer)).toMatchObject({
      currency: 'NPR',
      totalOpen: '50000.00',
      promiseMissed: true,
      promiseMissedOn: PROMISED,
    });

    // A second run plans nothing: still exactly one call on the customer.
    await expect(sweeper.sweep()).resolves.toEqual({ missed: 0, kept: 0, skipped: 0, failed: 0 });
    expect(await callsOn(customer)).toHaveLength(1);
    // The promise is history now, so a new one may be recorded.
    await h.actAs(accountant);
    await expect(record(invoice, { promisedDate: '2026-11-20' })).resolves.toMatchObject({
      status: 'open',
    });
  });

  it('refuses a past day, an unknown invoice and a role without payment.record', async () => {
    const invoice = await issuedInvoice(h.scopeA, customer, '1000.00');
    await h.actAs(accountant);
    await expect(record(invoice, { promisedDate: '2026-11-08' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(record(randomUUID(), { promisedDate: PROMISED })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    h.as('salesA', 'sales');
    await expect(record(invoice, { promisedDate: PROMISED })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('replays a committed promise retried after Kathmandu midnight instead of refusing its day', async () => {
    const invoice = await issuedInvoice(h.scopeA, customer, '2000.00');
    // 23:50 in Kathmandu on 2026-11-09: the promise is for that same day.
    let now = new Date('2026-11-09T18:05:00Z');
    const lateNight = new PaymentPromisesService(
      h.db,
      h.authz as unknown as AuthzService,
      new AuditService(h.db),
      () => now,
    );
    await h.actAs(accountant);
    const { scope, actor } = h.caller.current();
    const key = randomUUID();
    const body = { promisedDate: '2026-11-09' };
    const first = PaymentPromiseDtoSchema.parse(
      await lateNight.record(scope, actor, invoice, body, key),
    );

    // The response was lost; the client retries with the same key at 00:10 the next day.
    now = new Date('2026-11-09T18:25:00Z');
    await expect(lateNight.record(scope, actor, invoice, body, key)).resolves.toEqual(first);
    // A new key with that day is a new command, and the day is now in the past.
    await expect(
      lateNight.record(scope, actor, invoice, body, randomUUID()),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an invoice of another legal entity as unknown', async () => {
    const other = await issuedInvoice(h.scopeB, customer, '1000.00');
    await h.actAs(accountant);
    await expect(record(other, { promisedDate: PROMISED })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('replacing and listing promises to pay (R4c1 Q6)', () => {
  it('replaces the open promise in the same transaction, audits it, and replays the key without replacing again', async () => {
    const invoice = await issuedInvoice(h.scopeA, customer, '7000.00');
    await h.actAs(accountant);
    const first = PaymentPromiseDtoSchema.parse(
      await record(invoice, { promisedDate: '2026-11-15', note: 'First word' }),
    );

    // A second promise while the first is open replaces it (was 409 promise_open before 0153).
    const key = randomUUID();
    const second = PaymentPromiseDtoSchema.parse(
      await record(invoice, { promisedDate: '2026-11-25', note: 'Moved after the audit' }, key),
    );
    expect(second).toMatchObject({ status: 'open', promisedDate: '2026-11-25' });
    expect(second.id).not.toBe(first.id);

    // The recorder reads both back, newest first: the new one open, the old one replaced.
    const listed = await list(invoice);
    expect(listed.items.map((p) => [p.id, p.status])).toEqual([
      [second.id, 'open'],
      [first.id, 'replaced'],
    ]);
    expect(listed.items[0]).toMatchObject({
      recordedByUserId: accountant,
      recordedByName: 'Asha Accountant',
      note: 'Moved after the audit',
    });
    expect(listed.can).toEqual({ record: true, reason: null });
    const [old] = await withTx(h.db, h.scopeA, system, (tx) =>
      tx.select().from(paymentPromises).where(eq(paymentPromises.id, first.id)),
    );
    expect(old).toMatchObject({ status: 'replaced', version: 2, missedAt: null });

    // The replacement is audited on the old promise, naming the new one, by the recorder.
    const audited = await h.ownerPool.query(
      `SELECT action, actor_id, after FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_id = $2 AND action = 'payment_promise.replaced'`,
      [h.tenantId, first.id],
    );
    expect(audited.rows).toEqual([
      {
        action: 'payment_promise.replaced',
        actor_id: accountant,
        after: { status: 'replaced', replacedByPromiseId: second.id },
      },
    ]);

    // A retry of the second command replays its answer: no third row, nothing replaced again.
    await expect(
      record(invoice, { promisedDate: '2026-11-25', note: 'Moved after the audit' }, key),
    ).resolves.toEqual(second);
    expect((await list(invoice)).items.map((p) => [p.id, p.status])).toEqual([
      [second.id, 'open'],
      [first.id, 'replaced'],
    ]);

    // The hourly job never touches a replaced promise: after both days pass only the open one is missed.
    const late = new PaymentPromiseSweeper(
      drizzlePromiseStore(h.db),
      (scope, actor, fn) => withTx(h.db, scope, actor, fn),
      new AuditService(h.db),
      () => new Date('2026-11-26T06:00:00Z'),
      h.notify,
    );
    await late.sweep();
    expect((await list(invoice)).items.map((p) => p.status)).toEqual(['missed', 'replaced']);
  });

  it('tells a reader without payment.record why they cannot record, and refuses a role without ar.read', async () => {
    const invoice = await issuedInvoice(h.scopeA, customer, '3000.00');
    await h.actAs(accountant);
    const promise = PaymentPromiseDtoSchema.parse(
      await record(invoice, { promisedDate: PROMISED }),
    );

    // Management reads receivables but does not record payments.
    const manager = await h.member({ roles: ['management'], displayName: 'Mira Manager' });
    await h.actAs(manager);
    const seen = await list(invoice);
    expect(seen.items.map((p) => p.id)).toEqual([promise.id]);
    expect(seen.can).toEqual({ record: false, reason: 'no_permission' });

    h.as('salesA', 'sales');
    await expect(list(invoice)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("says a draft invoice is not open, and answers 404 for an unknown or another entity's invoice", async () => {
    const draft = await draftInvoice(h.scopeA, customer, '900.00');
    await h.actAs(accountant);
    await expect(list(draft)).resolves.toEqual({
      items: [],
      can: { record: false, reason: 'invoice_not_open' },
    });

    await expect(list(randomUUID())).rejects.toBeInstanceOf(NotFoundException);
    const other = await issuedInvoice(h.scopeB, customer, '1000.00');
    await expect(list(other)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('recording over an open promise whose day has passed', () => {
  /** A service and a sweeper reading one clock the test moves. */
  function clocked(start: string) {
    let now = new Date(start);
    const audit = new AuditService(h.db);
    return {
      at: (iso: string) => {
        now = new Date(iso);
      },
      service: new PaymentPromisesService(
        h.db,
        h.authz as unknown as AuthzService,
        audit,
        () => now,
      ),
      sweeper: new PaymentPromiseSweeper(
        drizzlePromiseStore(h.db),
        (scope, actor, fn) => withTx(h.db, scope, actor, fn),
        audit,
        () => now,
        h.notify,
      ),
    };
  }

  const stored = (id: string) =>
    withTx(h.db, h.scopeA, system, (tx) =>
      tx.select().from(paymentPromises).where(eq(paymentPromises.id, id)),
    ).then((rows) => rows[0]);

  it('refuses until the hourly job has checked it, which then marks it missed and plans the call', async () => {
    const invoice = await issuedInvoice(h.scopeA, customer, '4000.00');
    // 11:45 in Kathmandu on 2026-11-09: the promise is for that day.
    const t = clocked('2026-11-09T06:00:00Z');
    await h.actAs(accountant);
    const { scope, actor } = h.caller.current();
    const first = PaymentPromiseDtoSchema.parse(
      await t.service.record(scope, actor, invoice, { promisedDate: '2026-11-09' }, randomUUID()),
    );

    // 00:10 on 2026-11-10 in Kathmandu (still 2026-11-09 in UTC): the day has passed, the job has not run yet.
    t.at('2026-11-09T18:25:00Z');
    const refused = await t.service
      .record(scope, actor, invoice, { promisedDate: '2026-11-20' }, randomUUID())
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ConflictException);
    expect((refused as ConflictException).getResponse()).toEqual({
      code: 'promise_open',
      message: 'This promise date has passed and is being checked. Try again in a few minutes.',
    });
    // Nothing changed: the promise is still open, untouched, and no second one was stored.
    expect(await stored(first.id)).toMatchObject({ status: 'open', version: 1 });
    expect((await list(invoice)).items.map((p) => p.id)).toEqual([first.id]);

    // The job marks it missed and plans the collection call.
    await t.sweeper.sweep();
    const missed = await stored(first.id);
    expect(missed).toMatchObject({ status: 'missed' });
    expect(missed?.collectionActivityId).toEqual(expect.any(String));

    // Now a new promise may be recorded, and the missed one stays missed.
    await h.actAs(accountant);
    const next = PaymentPromiseDtoSchema.parse(
      await t.service.record(scope, actor, invoice, { promisedDate: '2026-11-20' }, randomUUID()),
    );
    expect((await list(invoice)).items.map((p) => [p.id, p.status])).toEqual([
      [next.id, 'open'],
      [first.id, 'missed'],
    ]);
  });

  it('still replaces an open promise for today before Kathmandu midnight', async () => {
    const invoice = await issuedInvoice(h.scopeA, customer, '4500.00');
    const t = clocked('2026-11-09T06:00:00Z');
    await h.actAs(accountant);
    const { scope, actor } = h.caller.current();
    const first = PaymentPromiseDtoSchema.parse(
      await t.service.record(scope, actor, invoice, { promisedDate: '2026-11-09' }, randomUUID()),
    );

    // 23:50 on 2026-11-09 in Kathmandu: the promised day is today, so it is replaced.
    t.at('2026-11-09T18:05:00Z');
    const second = PaymentPromiseDtoSchema.parse(
      await t.service.record(scope, actor, invoice, { promisedDate: '2026-11-12' }, randomUUID()),
    );
    expect((await list(invoice)).items.map((p) => [p.id, p.status])).toEqual([
      [second.id, 'open'],
      [first.id, 'replaced'],
    ]);
  });
});
