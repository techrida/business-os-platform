// Integration tests of QuotationSendService.send on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (so every CHECK and trigger of 0016 runs, S2's approved -> sent
// guard included), OpportunitiesService.markQuotationSent, NotifyService.notifyEmail writing app.outbox,
// AuditService and the idempotency helper. Faked: the request context, the outbox queue (nudge), the user directory
// (notifyEmail does not use it), and authz.assert, which still runs the real pure can() on a fake principal.
// Quotations are created through DraftingService.create, moved to Approved by raw SQL that follows 0016's transition
// guard (draft -> submitted -> approved, the submit statement writing both snapshot hashes), then given a rendered
// PDF the way the render sweeper leaves it: an app.documents row owned by the version, a document version in the
// wanted scan status, and render_state none -> pending -> rendered with rendered_document_id and rendered_sha256.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/send/quotation-send.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type QuotationDto,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createParty,
  opportunities,
  outbox,
  quotationStatusHistory,
  quotationVersions,
} from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import type { UserDirectory } from '../../../platform/authz/user-directory';
import type { CoreConfig } from '../../../platform/config/config';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { NotifyService } from '../../../platform/notify/notify.service';
import { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import type { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { LeadLostReasonsService } from '../../leads/lost-reasons.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { OpportunitiesService } from '../../opportunities/opportunities.service';
import { PortalController } from '../../portal/portal.controller';
import { PortalService } from '../../portal/portal.service';
import { DrizzlePortalQuotationStore } from '../../portal/portal.store';
import { DraftingService } from '../drafting/drafting.service';
import {
  goldenCreateBody,
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from '../drafting/quotation.fixture';
import { PricingService } from '../pricing/pricing.service';
import { QUOTATION_OWNER_TYPE } from '../quotation-owner.policy';
import { QuotationSendService, QuotationSendStore } from './quotation-send.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

/** 11:45 in Kathmandu on 9 Nov 2026; the golden body is valid until 2026-12-09. */
const NOW = new Date('2026-11-09T06:00:00Z');
/** 00:15 on 10 Dec 2026 in Kathmandu: the day after the golden valid_until. */
const AFTER_EXPIRY = new Date('2026-12-09T18:30:00Z');
const PORTAL = 'https://portal.example.test';
const BUYER_EMAIL = 'buyer@acme.example';

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: QuotationFixtureDb;
let f: QuotationFixture;
let scopeA: TxScope;
let scopeB: TxScope;
let drafting: DraftingService;
let service: QuotationSendService;
let expiredService: QuotationSendService;
let contactId: string;
let otherCustomerContactId: string;
const queue = { add: vi.fn(() => Promise.resolve()) };

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
/** The acting entity and grants of the fake caller; beforeEach resets both. */
const current: { scope: TxScope; grants: Map<Permission, Scope> } = {
  scope: { tenantId: '', organizationId: '' },
  grants: grantsOf('sales'),
};

const principalNow = (): Principal => ({
  userId: f.ownerUserId,
  zitadelUserId: `z-${f.ownerUserId}`,
  ...current.scope,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: 'unused',
  roles: [],
  departmentId: null,
  status: 'active',
  grants: current.grants,
});
const caller = {
  current: () => ({
    scope: current.scope,
    actor: { kind: 'user' as const, id: f.ownerUserId, correlationId: 'test-corr' },
    principal: principalNow(),
  }),
};
const authz = {
  assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
    const d = can(principalNow(), action, ref);
    if (!d.allowed) {
      throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: d.reason });
    }
  },
};
const money = {
  toNprSnapshot: () => Promise.reject(new Error('MoneyService is not used for NPR quotations')),
} as unknown as MoneyService;

/** A customer contact; `email` must already be lower-cased and trimmed (customer_contacts_email_norm_check). */
async function seedContact(customerId: string, email: string | null): Promise<string> {
  const { rows } = await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx.execute<{ id: string }>(
      sql`INSERT INTO app.customer_contacts (tenant_id, customer_id, full_name, email_norm)
          VALUES (${f.tenantId}, ${customerId}, 'Sita Buyer', ${email})
          RETURNING id`,
    ),
  );
  return rows[0]!.id;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  db = drizzle({ client: appPool });

  f = await seedQuotationFixture(db);
  scopeA = { tenantId: f.tenantId, organizationId: f.entityId };
  scopeB = { tenantId: f.tenantId, organizationId: f.otherEntityId };
  current.scope = scopeA;

  contactId = await seedContact(f.customerPartyId, BUYER_EMAIL);
  const { partyId: otherCustomerId } = await createParty(db.$client, {
    tenantId: f.tenantId,
    kind: 'customer',
  });
  await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address_line, address_city)
          VALUES (${otherCustomerId}, ${f.tenantId}, ${`CUS-${otherCustomerId.slice(0, 8)}`},
                  'Other Pvt. Ltd.', 'other', '2 New Road', 'Kathmandu')`,
    ),
  );
  otherCustomerContactId = await seedContact(otherCustomerId, 'someone@other.example');

  const audit = new AuditService(db);
  drafting = new DraftingService(
    db,
    new NumberingService(),
    new PricingService(money),
    authz as unknown as AuthzService,
    audit,
    caller,
    new CurrencyEnabledService(new SettingsService(db)),
  );
  const notify = new NotifyService(
    db,
    { WORKSPACE_PUBLIC_URL: 'https://app.example.test', PORTAL_PUBLIC_URL: PORTAL } as CoreConfig,
    {} as UserDirectory,
    queue as unknown as Queue,
  );
  const opps = new OpportunitiesService(
    db,
    authz as unknown as AuthzService,
    audit,
    caller,
    new LeadLostReasonsService(db, audit, caller),
  );
  const make = (now: Date) =>
    new QuotationSendService(
      db,
      authz as unknown as AuthzService,
      audit,
      opps,
      notify,
      new QuotationSendStore(),
      caller,
      () => now,
    );
  service = make(NOW);
  expiredService = make(AFTER_EXPIRY);
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

beforeEach(() => {
  current.scope = scopeA;
  current.grants = grantsOf('sales');
  queue.add.mockClear();
});

// ---------------------------------------------------------------------------------------- helpers

async function errorOf(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const codeOf = (error: HttpException) => (error.getResponse() as { code?: string }).code;

/** A qualified opportunity of entity A for the customer, so each test sees its own stage move. */
async function newOpportunity(): Promise<string> {
  const [row] = await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx
      .insert(opportunities)
      .values({
        ...scopeA,
        number: `DEAL-${randomUUID().slice(0, 8)}`,
        name: 'Acme website',
        customerId: f.customerPartyId,
        ownerUserId: f.ownerUserId,
        stage: 'qualified',
      })
      .returning({ id: opportunities.id }),
  );
  return row!.id;
}

const createQuotation = (opportunityId: string): Promise<QuotationDto> =>
  drafting.create(goldenCreateBody(f, { opportunityId }), `create-${randomUUID()}`);

const versionRow = async (id: string) => {
  const [row] = await db.select().from(quotationVersions).where(eq(quotationVersions.id, id));
  return row!;
};

/** draft -> submitted -> approved, one statement per step, as the revise integration test does it. */
async function approve(versionId: string): Promise<void> {
  await withTx(db, scopeA, systemActor('test'), async (tx) => {
    await tx.execute(
      sql`UPDATE app.quotation_versions
             SET status = 'submitted', submitted_at = now(), version = version + 1,
                 content_sha256 = sha256('content'::bytea), snapshot_sha256 = sha256('snapshot'::bytea)
           WHERE id = ${versionId}`,
    );
    await tx.execute(
      sql`UPDATE app.quotation_versions SET status = 'approved', approved_at = now(), version = version + 1
           WHERE id = ${versionId}`,
    );
  });
}

/**
 * The rendered PDF as the sweeper leaves it: a document owned by the version, one document version in `scan`
 * (inserted directly: the status guard runs on UPDATE only), and render_state pending -> rendered.
 */
async function render(versionId: string, scan: 'clean' | 'quarantined'): Promise<void> {
  await withTx(db, scopeA, systemActor('test'), async (tx) => {
    const { rows: doc } = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
          VALUES (${f.tenantId}, ${f.entityId}, ${QUOTATION_OWNER_TYPE}, ${versionId})
          RETURNING id`,
    );
    const documentId = doc[0]!.id;
    const { rows: ver } = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.document_versions (tenant_id, organization_id, document_id, version, filename,
            declared_mime, detected_mime, size_bytes, sha256, storage_key, status)
          VALUES (${f.tenantId}, ${f.entityId}, ${documentId}, 1, 'quotation.pdf', 'application/pdf',
                  'application/pdf', 1024, sha256('pdf'::bytea), ${`test/${randomUUID()}`}, ${scan})
          RETURNING id`,
    );
    if (scan === 'clean') {
      await tx.execute(
        sql`UPDATE app.documents SET current_version_id = ${ver[0]!.id} WHERE id = ${documentId}`,
      );
    }
    await tx.execute(
      sql`UPDATE app.quotation_versions SET render_state = 'pending' WHERE id = ${versionId}`,
    );
    await tx.execute(
      sql`UPDATE app.quotation_versions
             SET render_state = 'rendered', rendered_document_id = ${documentId},
                 rendered_sha256 = sha256('pdf'::bytea)
           WHERE id = ${versionId}`,
    );
  });
}

/** A quotation whose current version is in the wanted state; returns the ids and the row version to send with. */
async function quotationIn(state: {
  approved: boolean;
  scan: 'clean' | 'quarantined' | 'none';
}): Promise<{
  quotationId: string;
  versionId: string;
  expectedVersion: number;
  opportunityId: string;
}> {
  const opportunityId = await newOpportunity();
  const q = await createQuotation(opportunityId);
  const versionId = q.currentVersionId;
  if (state.approved) await approve(versionId);
  if (state.scan !== 'none') await render(versionId, state.scan);
  const { version: expectedVersion } = await versionRow(versionId);
  return { quotationId: q.id, versionId, expectedVersion, opportunityId };
}

const outboxRowsFor = (versionId: string) =>
  db
    .select()
    .from(outbox)
    .where(eq(outbox.dedupeKey, `quotation.sent:${versionId}`));

const stageOf = async (opportunityId: string) => {
  const [row] = await db
    .select({ stage: opportunities.stage })
    .from(opportunities)
    .where(eq(opportunities.id, opportunityId));
  return row!.stage;
};

// --------------------------------------------------------------------------------------------- send

describe('QuotationSendService.send', () => {
  it('sends an approved, rendered, clean quotation: sent, a portal-link email, the opportunity at quotation_sent', async () => {
    const { quotationId, versionId, expectedVersion, opportunityId } = await quotationIn({
      approved: true,
      scan: 'clean',
    });

    const dto = await service.send(
      quotationId,
      versionId,
      { recipientContactId: contactId, message: 'As discussed', expectedVersion },
      `send-${randomUUID()}`,
    );

    expect(dto).toMatchObject({ id: versionId, status: 'sent', renderedScanStatus: 'clean' });
    const row = await versionRow(versionId);
    expect(row.status).toBe('sent');
    expect(row.sentAt?.toISOString()).toBe(NOW.toISOString());
    expect(row.version).toBe(expectedVersion + 1);

    const history = await db
      .select()
      .from(quotationStatusHistory)
      .where(eq(quotationStatusHistory.versionId, versionId));
    expect(history.filter((h) => h.toStatus === 'sent')).toEqual([
      expect.objectContaining({ fromStatus: 'approved', actorId: f.ownerUserId }),
    ]);

    const emails = await outboxRowsFor(versionId);
    expect(emails).toHaveLength(1);
    const email = emails[0]!;
    expect(email).toMatchObject({
      kind: 'email',
      template: 'quotation.sent',
      toEmail: BUYER_EMAIL,
      toUserId: null,
      organizationId: f.entityId,
      status: 'pending',
    });
    // The portal's `/quotations/:id` is a version id (PortalService.get): the parent quotation id is "not found".
    const link = `${PORTAL}/quotations/${versionId}`;
    expect(email.bodyText).toContain(link);
    expect(email.bodyHtml).toContain(link);
    expect(email.bodyText).not.toContain(`/quotations/${quotationId}`);
    // A portal link, never a file: no document, download or PDF reference anywhere in the email.
    for (const body of [email.bodyText, email.bodyHtml ?? '']) {
      expect(body).not.toMatch(/\.pdf|\/documents\/|download|attachment/i);
    }

    expect(await stageOf(opportunityId)).toBe('quotation_sent');

    const { rows: audit } = await ownerPool.query<{ action: string }>(
      `SELECT action FROM audit.audit_events WHERE entity_id = $1 AND action = 'quotation.sent'`,
      [quotationId],
    );
    expect(audit).toHaveLength(1);
    // Nudged after the commit.
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('the emailed link opens the sent quotation in the customer portal, for that customer only', async () => {
    const { quotationId, versionId, expectedVersion } = await quotationIn({
      approved: true,
      scan: 'clean',
    });
    await service.send(
      quotationId,
      versionId,
      { recipientContactId: contactId, expectedVersion },
      `send-${randomUUID()}`,
    );
    // The portal shows the selling entity's address on every quotation (buildIssuer): without it the page is a 503.
    const settings = new SettingsService(db);
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      settings.set(tx, 'entity.address', {
        line: 'Durbar Marg 1',
        city: 'Kathmandu',
        country: 'NP',
      }),
    );

    // Follow the link exactly as the customer would: the path after PORTAL_PUBLIC_URL is the portal page
    // `apps/portal/src/app/(portal)/quotations/[id]/page.tsx`, whose `id` goes to GET /v1/portal/quotations/:id.
    const [email] = await outboxRowsFor(versionId);
    const escaped = PORTAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = new RegExp(`${escaped}/quotations/([^\\s"'<>/?#]+)`).exec(email!.bodyText);
    expect(match, 'a portal quotation link in the email').not.toBeNull();
    const emailedId = match![1]!;
    expect(emailedId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

    // The real controller, service and store, as the customer's portal user (customer_user grants).
    const portalAs = (partyId: string) => {
      const p: Principal = {
        userId: randomUUID(),
        zitadelUserId: 'z-portal-buyer',
        ...scopeA,
        orgKind: 'customer',
        partyId,
        idpOrgId: randomUUID(),
        roles: ['customer_user'],
        departmentId: null,
        status: 'active',
        grants: new Map<Permission, Scope>([['portal.quotation.read', 'customer_org']]),
      };
      // Only the PDF's scan status is read through documents; this test is about the lookup, not the PDF.
      const documents = { listForOwner: vi.fn().mockResolvedValue([]) };
      return new PortalController(
        new PortalService(
          { current: () => p },
          new DrizzlePortalQuotationStore(db),
          documents as never,
          settings,
        ),
      );
    };

    const view = await portalAs(f.customerPartyId).get(emailedId);
    expect(view).toMatchObject({ id: versionId, status: 'sent', revisionNo: 1 });
    // The parent quotation id (what the email used to carry) is not a portal id: the old link was a dead end.
    await expect(portalAs(f.customerPartyId).get(quotationId)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // No leak: the same link opens nothing for another customer, and says nothing about whether it exists.
    await expect(portalAs(randomUUID()).get(emailedId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('replays a retried send with the same key: the same answer and one outbox row', async () => {
    const { quotationId, versionId, expectedVersion } = await quotationIn({
      approved: true,
      scan: 'clean',
    });
    const key = `send-${randomUUID()}`;
    const body = { recipientContactId: contactId, expectedVersion };

    const first = await service.send(quotationId, versionId, body, key);
    const again = await service.send(quotationId, versionId, body, key);

    expect(again).toEqual(first);
    expect(await outboxRowsFor(versionId)).toHaveLength(1);
    expect((await versionRow(versionId)).version).toBe(expectedVersion + 1);
  });

  it.each([
    ['not approved', { approved: false, scan: 'none' as const }, 'quotation_not_approved'],
    ['not rendered', { approved: true, scan: 'none' as const }, 'quotation_not_rendered'],
    ['scan pending', { approved: true, scan: 'quarantined' as const }, 'quotation_scan_not_clean'],
  ])('refuses a quotation that is %s with 409 and leaves it as it was', async (_n, state, code) => {
    const { quotationId, versionId, expectedVersion, opportunityId } = await quotationIn(state);
    const before = await versionRow(versionId);

    const error = await errorOf(
      service.send(
        quotationId,
        versionId,
        { recipientContactId: contactId, expectedVersion },
        `send-${randomUUID()}`,
      ),
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect(codeOf(error)).toBe(code);
    expect(await versionRow(versionId)).toMatchObject({
      status: before.status,
      version: before.version,
    });
    expect(await outboxRowsFor(versionId)).toHaveLength(0);
    expect(await stageOf(opportunityId)).toBe('qualified');
  });

  it('refuses an expired quotation (valid_until before today in Kathmandu) with 409', async () => {
    const { quotationId, versionId, expectedVersion } = await quotationIn({
      approved: true,
      scan: 'clean',
    });

    const error = await errorOf(
      expiredService.send(
        quotationId,
        versionId,
        { recipientContactId: contactId, expectedVersion },
        `send-${randomUUID()}`,
      ),
    );

    expect(error).toBeInstanceOf(ConflictException);
    expect(codeOf(error)).toBe('quotation_expired');
    expect((await versionRow(versionId)).status).toBe('approved');
    expect(await outboxRowsFor(versionId)).toHaveLength(0);
  });

  it('refuses a contact of another customer with 400 and sends nothing', async () => {
    const { quotationId, versionId, expectedVersion } = await quotationIn({
      approved: true,
      scan: 'clean',
    });

    const error = await errorOf(
      service.send(
        quotationId,
        versionId,
        { recipientContactId: otherCustomerContactId, expectedVersion },
        `send-${randomUUID()}`,
      ),
    );

    expect(error).toBeInstanceOf(BadRequestException);
    expect((await versionRow(versionId)).status).toBe('approved');
    expect(await outboxRowsFor(versionId)).toHaveLength(0);
  });

  it('refuses a contact without an email with 400', async () => {
    const { quotationId, versionId, expectedVersion } = await quotationIn({
      approved: true,
      scan: 'clean',
    });
    const noEmail = await seedContact(f.customerPartyId, null);

    const error = await errorOf(
      service.send(
        quotationId,
        versionId,
        { recipientContactId: noEmail, expectedVersion },
        `send-${randomUUID()}`,
      ),
    );

    expect(error).toBeInstanceOf(BadRequestException);
  });

  it('answers 404 when the caller acts for another legal entity, and changes nothing', async () => {
    const { quotationId, versionId, expectedVersion } = await quotationIn({
      approved: true,
      scan: 'clean',
    });
    current.scope = scopeB;

    const error = await errorOf(
      service.send(
        quotationId,
        versionId,
        { recipientContactId: contactId, expectedVersion },
        `send-${randomUUID()}`,
      ),
    );

    expect(error).toBeInstanceOf(NotFoundException);
    current.scope = scopeA;
    expect((await versionRow(versionId)).status).toBe('approved');
    expect(await outboxRowsFor(versionId)).toHaveLength(0);
  });
});
