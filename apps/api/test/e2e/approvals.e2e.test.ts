// The P1 exit check at the API layer (architecture/model.js): "A test document goes through a two-step approval
// with no self-approval, an email, a scanned upload and a full audit trail." Real AppModule and a real
// in-process WorkerModule, real Postgres, Valkey and Mailpit (Testcontainers), a fake clamd that speaks the
// real protocol, and ZITADEL-shaped tokens. Serves the NFRs "no double decisions", "authorization is
// deny-by-default", "every change is audited" and "notifications are delivered", end to end in one story.
//
// Each step prints one summary line, so a run can be quoted as evidence.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ApprovalRequestDtoSchema,
  AuditEventDtoSchema,
  ChainVerifyDtoSchema,
  ErrorBodySchema,
  NotificationDtoSchema,
  RoutePlanSchema,
  type ApprovalRequestDto,
  type AuditEventDto,
} from '@bos/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import {
  eicarBytes,
  startFakeClamd,
  type FakeClamd,
} from '../../src/platform/documents/fake-clamd';
import { startApp, type TestApp } from './support/app';
import {
  minimalPdf,
  pollUntil,
  seedApprovalsWorld,
  type ApprovalsWorld,
  type Persona,
  type PersonaKey,
} from './support/fixtures';
import { mailpit, type Mailpit } from './support/mailpit';
import { startWorker, type TestWorker } from './support/worker';

const e2e = inject('e2e');

let t: TestApp;
let worker: TestWorker;
let clamd: FakeClamd;
let world: ApprovalsWorld;
let mail: Mailpit;
let filesRoot: string;

beforeAll(async () => {
  clamd = await startFakeClamd();
  // A WSL/Linux tmp dir: the EICAR bytes may only ever touch a path like this, never the Windows tree.
  filesRoot = await mkdtemp(join(tmpdir(), 'bos-e2e-files-'));
  world = await seedApprovalsWorld(e2e);
  mail = mailpit(e2e.mailpitApiUrl);

  // Read by AppModule and WorkerModule when they are imported, so set before either boots.
  Object.assign(process.env, {
    CLAMD_HOST: clamd.host,
    CLAMD_PORT: String(clamd.port),
    SMTP_URL: e2e.mailpitSmtpUrl,
    MAIL_FROM: 'Business OS e2e <noreply@e2e-approvals.test>',
    FILES_ROOT: filesRoot,
    DOCS_LINK_SECRET: 'e2e-approvals-docs-link-secret-0123456789abcdef',
    WORKSPACE_PUBLIC_URL: 'http://app.e2e.test',
  });
  t = await startApp();
  worker = await startWorker();
});

afterAll(async () => {
  // Worker first (its BullMQ handles would keep the process alive), then the app, then the fakes.
  await worker?.close();
  await t?.close();
  await clamd?.close();
  await world?.close();
  if (filesRoot) await rm(filesRoot, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------ helpers

const p = (key: PersonaKey): Persona => world.personas[key];

async function auth(key: PersonaKey, roles?: string[]): Promise<string> {
  const persona = p(key);
  return `Bearer ${await t.token(e2e.staff, { userId: persona.sub, roles: roles ?? persona.tokenRoles })}`;
}

function errorOf(body: unknown): { code: string; reason?: string } {
  const parsed = ErrorBodySchema.parse(body);
  const reason = (body as { error?: { reason?: unknown } }).error?.reason;
  return { code: parsed.error.code, ...(typeof reason === 'string' ? { reason } : {}) };
}

/** Status plus body, so a failed assertion shows what the API actually said. */
const show = (res: { status: number; body: unknown }): string =>
  `${res.status} ${JSON.stringify(res.body)}`;

async function createMemo(
  authz: string,
  title: string,
  amount: string,
): Promise<{ id: string; number: string; amountNpr: string }> {
  const res = await t
    .http()
    .post('/v1/test-memos')
    .set('authorization', authz)
    .send({ title, body: 'Created by the approvals exit e2e.', amount, currency: 'NPR' });
  expect(res.status, show(res)).toBe(201);
  return res.body as { id: string; number: string; amountNpr: string };
}

async function attach(
  authz: string,
  memoId: string,
  file: { name: string; mime: string; bytes: Buffer },
): Promise<{ documentId: string; versionId: string }> {
  const created = await t.http().post('/v1/documents').set('authorization', authz).send({
    ownerType: 'test_memo',
    ownerId: memoId,
    filename: file.name,
    declaredMime: file.mime,
    sizeBytes: file.bytes.length,
  });
  expect(created.status, show(created)).toBe(201);
  const { documentId, versionId, uploadPath } = created.body as {
    documentId: string;
    versionId: string;
    uploadPath: string;
  };
  const put = await t
    .http()
    .put(uploadPath)
    .set('authorization', authz)
    .set('content-type', file.mime)
    .send(file.bytes);
  expect(put.status, show(put)).toBe(200);
  return { documentId, versionId };
}

/** Polls GET /v1/test-memos/:id until the attachment version reaches a final scan status. */
async function waitForScan(
  authz: string,
  memoId: string,
  versionId: string,
  want: string,
): Promise<string> {
  return pollUntil(
    `version ${versionId} to become ${want}`,
    async () => {
      const res = await t.http().get(`/v1/test-memos/${memoId}`).set('authorization', authz);
      const att = (
        res.body as { attachments?: { id: string; status: string }[] }
      ).attachments?.find((a) => a.id === versionId);
      const final = ['clean', 'infected', 'rejected', 'scan_failed'];
      return {
        done: att !== undefined && final.includes(att.status) ? att.status : undefined,
        last: { status: res.status, attachment: att ?? null },
      };
    },
    20_000,
  );
}

async function getRequest(authz: string, requestId: string): Promise<ApprovalRequestDto> {
  const res = await t.http().get(`/v1/approvals/requests/${requestId}`).set('authorization', authz);
  expect(res.status, show(res)).toBe(200);
  return ApprovalRequestDtoSchema.parse(res.body);
}

function act(authz: string, requestId: string, key: string, body: Record<string, unknown>) {
  return t
    .http()
    .post(`/v1/approvals/requests/${requestId}/actions`)
    .set('authorization', authz)
    .set('idempotency-key', key)
    .send(body);
}

async function auditFor(authz: string, entityId: string): Promise<AuditEventDto[]> {
  const res = await t
    .http()
    .get('/v1/audit')
    .query({ entityId, limit: 500 })
    .set('authorization', authz);
  expect(res.status, show(res)).toBe(200);
  return (res.body as { items: unknown[] }).items.map((i) => AuditEventDtoSchema.parse(i));
}

const afterStatus = (e: AuditEventDto): unknown => (e.after as { status?: unknown } | null)?.status;

// ------------------------------------------------------------------------------------------- the scenario

describe('P1 exit scenario: two-step approval of a test memo', () => {
  // Shared across the ordered steps below (one story, told step by step).
  const s = {
    memoId: '',
    memoNumber: '',
    amountNpr: '',
    documentId: '',
    versionId: '',
    requestId: '',
  };

  it('1. sales creates an NPR 50,000 memo, uploads a PDF, and the scan marks it clean', async () => {
    const sales = await auth('sales');
    const memo = await createMemo(sales, 'Exit e2e: office supplies', '50000');
    Object.assign(s, { memoId: memo.id, memoNumber: memo.number, amountNpr: memo.amountNpr });

    const pdf = minimalPdf();
    const doc = await attach(sales, s.memoId, {
      name: 'quote.pdf',
      mime: 'application/pdf',
      bytes: pdf,
    });
    Object.assign(s, doc);

    const status = await waitForScan(sales, s.memoId, s.versionId, 'clean');
    expect(status).toBe('clean');
    expect(clamd.scans.length).toBeGreaterThanOrEqual(1);
    console.log(
      `step 1: memo ${s.memoNumber} (NPR ${s.amountNpr}) created by sales; ${pdf.length}-byte PDF ` +
        `scanned by clamd -> ${status}`,
    );
  }, 60_000);

  it('2. preview shows two steps with reasons; sales submits and the request is pending', async () => {
    const sales = await auth('sales');
    const preview = await t
      .http()
      .post('/v1/approvals/preview')
      .set('authorization', sales)
      .send({ documentType: 'test_memo', facts: { amountNpr: s.amountNpr } });
    expect(preview.status, show(preview)).toBe(200);
    const plan = RoutePlanSchema.parse(preview.body);
    expect(plan.blocked).toBe(false);
    expect(plan.steps).toHaveLength(2);
    expect(plan.steps.map((st) => st.roleKey)).toEqual(['accountant', 'finance']);
    for (const st of plan.steps) expect(st.reason.length).toBeGreaterThan(0);
    // Sales cannot act on approvals, so the preview names no approvers to it (review R22).
    for (const st of plan.steps) expect(st.eligibleUserIds).toEqual([]);
    // Someone who may act sees who is eligible. Preview treats the caller as the requester, so it is
    // asked by the founder: an approver on this route would be excluded from their own step by SoD.
    const asFounder = await t
      .http()
      .post('/v1/approvals/preview')
      .set('authorization', await auth('founder'))
      .send({ documentType: 'test_memo', facts: { amountNpr: s.amountNpr } });
    expect(asFounder.status, show(asFounder)).toBe(200);
    const approverPlan = RoutePlanSchema.parse(asFounder.body);
    expect(approverPlan.steps[0]?.eligibleUserIds).toEqual([p('accountant').userId]);
    expect(approverPlan.steps[1]?.eligibleUserIds).toEqual([p('finance').userId]);

    const submit = await t
      .http()
      .post(`/v1/test-memos/${s.memoId}/submit`)
      .set('authorization', sales);
    expect(submit.status, show(submit)).toBe(200);
    expect(submit.body).toMatchObject({ status: 'pending' });
    s.requestId = (submit.body as { requestId: string }).requestId;
    console.log(
      `step 2: preview ${plan.steps.length} steps [${plan.steps.map((st) => `${st.roleKey}: "${st.reason}"`).join('; ')}]; ` +
        `submit -> ${(submit.body as { status: string }).status} (request ${s.requestId})`,
    );
  });

  it('3. no self-approval: sales gets 403, finance on step 1 gets 403 out_of_scope', async () => {
    const before = await getRequest(await auth('finance'), s.requestId);
    expect(before.status).toBe('pending');
    expect(before.currentSeq).toBe(1);

    const salesTry = await act(await auth('sales'), s.requestId, randomUUID(), {
      action: 'approve',
      expectedVersion: before.version,
    });
    expect(salesTry.status, show(salesTry)).toBe(403);
    const salesErr = errorOf(salesTry.body);
    expect(salesErr.code).toBe('forbidden');

    // The current version, so a 409 cannot hide the 403 (act() checks the version before the scope).
    const financeTry = await act(await auth('finance'), s.requestId, randomUUID(), {
      action: 'approve',
      expectedVersion: before.version,
    });
    expect(financeTry.status, show(financeTry)).toBe(403);
    const financeErr = errorOf(financeTry.body);
    expect(financeErr).toMatchObject({ code: 'forbidden', reason: 'out_of_scope' });
    console.log(
      `step 3: sales approve -> 403 ${salesErr.code}${salesErr.reason ? `/${salesErr.reason}` : ''}; ` +
        `finance on step 1 -> 403 ${financeErr.code}/${financeErr.reason}`,
    );
  });

  it('4. accountant approves with an Idempotency-Key; a replay is identical, one action row, stale version 409', async () => {
    const accountant = await auth('accountant');
    const before = await getRequest(accountant, s.requestId);
    const key = randomUUID();
    const body = { action: 'approve', expectedVersion: before.version };

    const first = await act(accountant, s.requestId, key, body);
    expect(first.status, show(first)).toBe(200);
    const dto = ApprovalRequestDtoSchema.parse(first.body);
    expect(dto.status).toBe('pending');
    expect(dto.currentSeq).toBe(2);
    expect(dto.version).toBeGreaterThan(before.version);

    const replay = await act(accountant, s.requestId, key, body);
    expect(replay.status, show(replay)).toBe(200);
    expect(replay.body).toEqual(first.body);

    const rows = await world.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app.approval_actions WHERE request_id = $1 AND action = 'approve'`,
      [s.requestId],
    );
    expect(rows.rows[0]?.n).toBe('1');

    // A fresh key: reusing `key` with another body would hit the key-mismatch check, not the version check.
    const stale = await act(await auth('finance'), s.requestId, randomUUID(), {
      action: 'approve',
      expectedVersion: before.version,
    });
    expect(stale.status, show(stale)).toBe(409);
    expect(errorOf(stale.body).code).toBe('conflict');
    console.log(
      `step 4: accountant approve -> 200 (v${before.version} -> v${dto.version}, now step ${dto.currentSeq}); ` +
        `replay same key -> identical body; approve rows in DB = ${rows.rows[0]?.n}; ` +
        `stale expectedVersion v${before.version} -> 409 conflict`,
    );
  });

  it('5. finance approves step 2 and the memo is approved', async () => {
    const finance = await auth('finance');
    const before = await getRequest(finance, s.requestId);
    const res = await act(finance, s.requestId, randomUUID(), {
      action: 'approve',
      expectedVersion: before.version,
    });
    expect(res.status, show(res)).toBe(200);
    const dto = ApprovalRequestDtoSchema.parse(res.body);
    expect(dto.status).toBe('approved');
    expect(dto.decidedAt).not.toBeNull();

    const memo = await t
      .http()
      .get(`/v1/test-memos/${s.memoId}`)
      .set('authorization', await auth('sales'));
    expect(memo.status, show(memo)).toBe(200);
    expect(memo.body).toMatchObject({
      status: 'approved',
      approval: { requestId: s.requestId, status: 'approved' },
    });
    console.log(
      `step 5: finance approve -> request ${dto.status}; memo ${s.memoNumber} status ${(memo.body as { status: string }).status}`,
    );
  });

  it('6. Mailpit holds the approval.pending email(s) and the approval.decided email', async () => {
    const hasTo = (m: { To: { Address: string }[] }, email: string): boolean =>
      m.To.some((to) => to.Address.toLowerCase() === email.toLowerCase());
    const forMemo = (m: { Subject: string }): boolean => m.Subject.includes(s.memoNumber);

    // approval.pending renders "Approval needed: <type> <number>" (templates.ts).
    const pendingAccountant = await mail.waitFor(
      (m) =>
        forMemo(m) && m.Subject.startsWith('Approval needed') && hasTo(m, p('accountant').email),
      'approval.pending to the accountant',
    );
    const pendingFinance = await mail.waitFor(
      (m) => forMemo(m) && m.Subject.startsWith('Approval needed') && hasTo(m, p('finance').email),
      'approval.pending to finance (step 2 activation)',
    );
    // approval.decided goes to the requester; its subject is "<type> <number>: <decision>".
    const decided = await mail.waitFor(
      (m) => forMemo(m) && !m.Subject.startsWith('Approval needed') && hasTo(m, p('sales').email),
      'approval.decided to the requester',
    );
    console.log(
      `step 6: Mailpit: "${pendingAccountant.Subject}" -> ${p('accountant').email}; ` +
        `"${pendingFinance.Subject}" -> ${p('finance').email}; "${decided.Subject}" -> ${p('sales').email}`,
    );
  }, 60_000);

  it('7. the audit trail lists create, upload, scan, submit, approve x2 and the status changes; verify is ok', async () => {
    const finance = await auth('finance');
    const memoEvents = await auditFor(finance, s.memoId);
    const docEvents = await auditFor(finance, s.documentId);
    const versionEvents = await auditFor(finance, s.versionId);
    const requestEvents = await auditFor(finance, s.requestId);
    const actions = (es: AuditEventDto[]): string[] =>
      es.map(
        (e) => `${e.action}${afterStatus(e) !== undefined ? `(${String(afterStatus(e))})` : ''}`,
      );
    console.log(
      `step 7 (trail): memo [${actions(memoEvents).join(', ')}]; document [${actions(docEvents).join(', ')}]; ` +
        `version [${actions(versionEvents).join(', ')}]; request [${actions(requestEvents).join(', ')}]`,
    );

    const has = (es: AuditEventDto[], action: string, status?: string): boolean =>
      es.some((e) => e.action === action && (status === undefined || afterStatus(e) === status));

    // Every event in the trail belongs to this tenant and names who did it.
    for (const e of [...memoEvents, ...docEvents, ...versionEvents, ...requestEvents]) {
      expect(e.tenantId).toBe(e2e.tenantId);
      expect(e.actorId.length).toBeGreaterThan(0);
    }

    const missing: string[] = [];
    const want = (ok: boolean, label: string): void => {
      if (!ok) missing.push(label);
    };
    // Create: the memo row and the document row (audit trigger).
    want(has(memoEvents, 'test_memos.insert'), 'memo create (test_memos.insert)');
    want(
      has(docEvents, 'documents.insert') || has(versionEvents, 'document_versions.insert'),
      'document create',
    );
    // Upload: the version leaves awaiting_content once the bytes are in quarantine.
    want(
      has(versionEvents, 'document_versions.update', 'quarantined'),
      'upload (version -> quarantined)',
    );
    // Scan: the processor's explicit event plus the status change to clean.
    want(has(versionEvents, 'document.scanned'), 'scan (document.scanned)');
    want(
      has(versionEvents, 'document_versions.update', 'clean'),
      'scan status change (version -> clean)',
    );
    // Submit and the two approvals.
    want(has(requestEvents, 'approvals.submit'), 'submit (approvals.submit)');
    want(
      requestEvents.filter((e) => e.action === 'approvals.approve').length === 2,
      'approve x2 (approvals.approve twice)',
    );
    // Status changes on the memo and the request.
    want(has(memoEvents, 'test_memos.update', 'submitted'), 'memo status -> submitted');
    want(has(memoEvents, 'test_memos.update', 'approved'), 'memo status -> approved');
    want(has(requestEvents, 'approval_requests.update', 'approved'), 'request status -> approved');
    expect(missing, 'audit events missing from the trail').toEqual([]);

    const month = new Date().toISOString().slice(0, 7);
    const verify = await t
      .http()
      .get('/v1/audit/verify')
      .query({ month })
      .set('authorization', finance);
    expect(verify.status, show(verify)).toBe(200);
    const chain = ChainVerifyDtoSchema.parse(verify.body);
    expect(chain).toMatchObject({ tenantId: e2e.tenantId, month, ok: true, firstBadSeq: null });
    expect(chain.rows).toBeGreaterThan(0);
    console.log(
      `step 7: audit events memo=${memoEvents.length} document=${docEvents.length} version=${versionEvents.length} ` +
        `request=${requestEvents.length}; verify ${month} ok=${chain.ok} over ${chain.rows} rows`,
    );
  });
});

describe('P1 exit scenario: negatives', () => {
  it('an accountant-created memo, with that accountant the only one, is blocked and the founder is notified', async () => {
    // The accountant also holds sales (approvers have no memo.create): see support/fixtures.ts.
    const authorSelf = await auth('accountant', ['accountant', 'sales']);
    const memo = await createMemo(authorSelf, 'Exit e2e: authored by the only accountant', '1000');
    const submit = await t
      .http()
      .post(`/v1/test-memos/${memo.id}/submit`)
      .set('authorization', authorSelf);
    expect(submit.status, show(submit)).toBe(200);
    expect(submit.body).toMatchObject({ status: 'blocked' });

    const list = await t
      .http()
      .get('/v1/notifications')
      .set('authorization', await auth('founder'));
    expect(list.status, show(list)).toBe(200);
    const notices = (list.body as unknown[]).map((n) => NotificationDtoSchema.parse(n));
    const notice = notices.find((n) => n.title.includes(memo.number));
    expect(
      notice,
      `founder notifications: ${JSON.stringify(notices.map((n) => n.title))}`,
    ).toBeDefined();
    expect(notice?.title).toMatch(/blocked/i);
    console.log(
      `negative 1: accountant-authored memo ${memo.number} submit -> ${(submit.body as { status: string }).status}; ` +
        `founder notification "${notice?.title}"`,
    );
  });

  it('an EICAR upload ends infected and submit answers 409', async () => {
    const sales = await auth('sales');
    const memo = await createMemo(sales, 'Exit e2e: infected attachment', '2500');
    // Declared text/csv: EICAR is plain ASCII, so it passes the type check and actually reaches the scanner.
    const doc = await attach(sales, memo.id, {
      name: 'eicar.csv',
      mime: 'text/csv',
      bytes: eicarBytes(),
    });
    const status = await waitForScan(sales, memo.id, doc.versionId, 'infected');
    if (status !== 'infected') {
      // Logs are silent in e2e, so gather the evidence a reader needs to place the fault.
      const trail = await auditFor(await auth('finance'), doc.versionId);
      const { renderEmail } = await import('../../src/platform/notify/templates');
      let render = 'ok';
      try {
        // The exact vars ScanProcessor passes on the infected path.
        renderEmail(
          'document.infected',
          { filename: 'eicar.csv', linkPath: '/inbox' },
          { workspaceUrl: 'http://app.e2e.test' },
        );
      } catch (error) {
        render = `${(error as Error).name}: ${(error as Error).message}`;
      }
      console.log(
        `negative 2 (diagnosis): version ended ${status}; fake clamd scans=${clamd.scans.length}; ` +
          `version trail [${trail.map((e) => `${e.action}(${JSON.stringify(afterStatus(e) ?? null)})`).join(', ')}]; ` +
          `renderEmail(document.infected, linkPath '/inbox') -> ${render}`,
      );
    }
    expect(status).toBe('infected');

    const submit = await t
      .http()
      .post(`/v1/test-memos/${memo.id}/submit`)
      .set('authorization', sales);
    expect(submit.status, show(submit)).toBe(409);
    expect(errorOf(submit.body).code).toBe('conflict');
    console.log(
      `negative 2: EICAR upload -> ${status}; submit -> ${submit.status} ${errorOf(submit.body).code}`,
    );
  }, 60_000);
});
