// Step-up (K7) over the wire: approving a Founder step needs the user's ID token in `x-bos-id-token`,
// proving a recent sign-in. ZITADEL puts `auth_time` only in the ID token, never in the access token,
// so this is the one place a unit test with a hand-built verifier cannot show the whole chain: the
// real AppModule, the real JwtVerifier fetching the issuer's JWKS, the real controller and the real
// approvals service on Postgres.
//
// The route is the production seed's (tools/seed-zitadel): a memo over NPR 10,00,000 is routed
// accountant -> finance -> management -> founder, so the Founder step is reached by approving the three
// steps before it. Those three decisions are also the "a non-Founder step needs no header" proof.
//
// Seeds its own tenant: the approver lookup counts everyone holding a role in the org, so adding a second
// accountant to the shared staff org would change what the approvals e2e sees as eligible.
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ApprovalRequestDtoSchema, ErrorBodySchema, type ApprovalRequestDto } from '@bos/contracts';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { startFakeClamd, type FakeClamd } from '../../src/platform/documents/fake-clamd';
import { CLIENT_ID, startApp, type TestApp } from './support/app';
import {
  createIsolatedStaffOrg,
  seedApprovalsWorld,
  type ApprovalsWorld,
  type Persona,
  type PersonaKey,
} from './support/fixtures';

const e2e = inject('e2e');

/** A ZITADEL org id no other e2e file uses. */
const ISOLATED_ZITADEL_ORG_ID = '310000000000000077';

let t: TestApp;
let clamd: FakeClamd;
let world: ApprovalsWorld;
let staff: { zitadelOrgId: string };
let filesRoot: string;

beforeAll(async () => {
  clamd = await startFakeClamd();
  filesRoot = await mkdtemp(join(tmpdir(), 'bos-e2e-step-up-'));
  const isolated = await createIsolatedStaffOrg(e2e, ISOLATED_ZITADEL_ORG_ID);
  staff = isolated.staff;
  world = await seedApprovalsWorld({ ...e2e, ...isolated }, 'e2e-step-up');

  // The same settings as the approvals e2e: AppModule reads them when it is imported. No worker is
  // started, nothing here waits for an email or a scan.
  Object.assign(process.env, {
    CLAMD_HOST: clamd.host,
    CLAMD_PORT: String(clamd.port),
    SMTP_URL: e2e.mailpitSmtpUrl,
    MAIL_FROM: 'Business OS e2e <noreply@e2e-step-up.test>',
    FILES_ROOT: filesRoot,
    DOCS_LINK_SECRET: 'e2e-step-up-docs-link-secret-0123456789abcdef',
    WORKSPACE_PUBLIC_URL: 'http://app.e2e.test',
  });
  t = await startApp();
});

afterAll(async () => {
  await t?.close();
  await clamd?.close();
  await world?.close();
  if (filesRoot) await rm(filesRoot, { recursive: true, force: true });
});

// ------------------------------------------------------------------------------------------------ helpers

const p = (key: PersonaKey): Persona => world.personas[key];

/** The access token of a persona: ZITADEL-shaped, and with no `auth_time` like the real thing. */
async function auth(key: PersonaKey, options: { authTime?: number } = {}): Promise<string> {
  const persona = p(key);
  return `Bearer ${await t.token(staff, { userId: persona.sub, roles: persona.tokenRoles, ...options })}`;
}

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** An ID token as the BFF would forward it, for `key`'s own `sub` unless `sub` says otherwise. */
function idTokenFor(
  key: PersonaKey,
  options: Partial<Parameters<TestApp['issuer']['mintIdToken']>[0]> = {},
): Promise<string> {
  return t.issuer.mintIdToken({
    sub: p(key).sub,
    authTime: nowSeconds() - 10,
    audience: CLIENT_ID,
    ...options,
  });
}

/** Status plus body, so a failed assertion shows what the API actually said. */
const show = (res: { status: number; body: unknown }): string =>
  `${res.status} ${JSON.stringify(res.body)}`;

async function getRequest(authz: string, requestId: string): Promise<ApprovalRequestDto> {
  const res = await t.http().get(`/v1/approvals/requests/${requestId}`).set('authorization', authz);
  expect(res.status, show(res)).toBe(200);
  return ApprovalRequestDtoSchema.parse(res.body);
}

/** One decision call. `headers` is where the ID token goes; a fresh Idempotency-Key per call. */
function approve(
  authz: string,
  requestId: string,
  expectedVersion: number,
  headers: Record<string, string> = {},
) {
  return t
    .http()
    .post(`/v1/approvals/requests/${requestId}/actions`)
    .set('authorization', authz)
    .set('idempotency-key', randomUUID())
    .set(headers)
    .send({ action: 'approve', expectedVersion });
}

async function approveRows(requestId: string): Promise<number> {
  const rows = await world.pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM app.approval_actions WHERE request_id = $1 AND action = 'approve'`,
    [requestId],
  );
  return Number(rows.rows[0]?.n);
}

function expectStepUpRequired(res: { status: number; body: unknown }): void {
  expect(res.status, show(res)).toBe(401);
  expect(ErrorBodySchema.parse(res.body).error.code).toBe('step_up_required');
}

// ------------------------------------------------------------------------------------------- the scenario

describe('step-up: approving a Founder step needs a recent sign-in (x-bos-id-token)', () => {
  // Shared across the ordered steps below (one story, told step by step).
  const s = { requestId: '', version: 0 };

  it('1. a memo over NPR 10,00,000 is submitted and routed accountant, finance, management, founder', async () => {
    const sales = await auth('sales');
    const created = await t.http().post('/v1/test-memos').set('authorization', sales).send({
      title: 'Step-up e2e: large purchase',
      body: 'Created by the step-up e2e.',
      amount: '1500000',
      currency: 'NPR',
    });
    expect(created.status, show(created)).toBe(201);
    const memoId = (created.body as { id: string }).id;

    const submit = await t
      .http()
      .post(`/v1/test-memos/${memoId}/submit`)
      .set('authorization', sales);
    expect(submit.status, show(submit)).toBe(200);
    s.requestId = (submit.body as { requestId: string }).requestId;

    const request = await getRequest(await auth('founder'), s.requestId);
    expect(request.status).toBe('pending');
    expect(request.steps.map((st) => (st.kind === 'role' ? st.roleKey : st.kind))).toEqual([
      'accountant',
      'finance',
      'management',
      'founder',
    ]);
  });

  it('2. steps that are not the Founder step are decided without the header (200)', async () => {
    for (const [key, seq] of [
      ['accountant', 1],
      ['finance', 2],
      ['management', 3],
    ] as const) {
      const authz = await auth(key);
      const before = await getRequest(authz, s.requestId);
      expect(before.currentSeq, `${key} should be the current step`).toBe(seq);

      // No x-bos-id-token at all: the controller must not ask for one on these steps.
      const res = await approve(authz, s.requestId, before.version);
      expect(res.status, show(res)).toBe(200);
      expect(ApprovalRequestDtoSchema.parse(res.body).currentSeq).toBe(seq + 1);
    }
    const now = await getRequest(await auth('founder'), s.requestId);
    expect(now.status).toBe('pending');
    expect(now.currentSeq).toBe(4);
    const current = now.steps.find((st) => st.seq === now.currentSeq);
    expect(current).toMatchObject({ kind: 'role', roleKey: 'founder' });
    s.version = now.version;
    expect(await approveRows(s.requestId)).toBe(3);
  });

  // Every case below is refused before the service runs, so the request stays on the Founder step at
  // the same version and each case can use the same expectedVersion.
  describe('3. the Founder cannot decide without proof of a recent sign-in (401 step_up_required)', () => {
    const refused: [string, () => Promise<{ headers: Record<string, string>; access?: string }>][] =
      [
        ['no x-bos-id-token header', () => Promise.resolve({ headers: {} })],
        [
          'a stale ID token (auth_time 10 minutes ago, window 5)',
          async () => ({
            headers: {
              'x-bos-id-token': await idTokenFor('founder', { authTime: nowSeconds() - 600 }),
            },
          }),
        ],
        [
          "another user's ID token (sub is not the access token's)",
          async () => ({
            headers: { 'x-bos-id-token': await idTokenFor('finance') },
          }),
        ],
        [
          'an access token with a fresh auth_time and no ID token (access tokens are never trusted for it)',
          async () => ({ headers: {}, access: await auth('founder', { authTime: nowSeconds() }) }),
        ],
        [
          'the access token itself sent as the ID token (right sub, no auth_time)',
          async () => ({
            headers: { 'x-bos-id-token': (await auth('founder')).replace('Bearer ', '') },
          }),
        ],
        [
          'an ID token for another client (aud not in the allow-list)',
          async () => ({
            headers: {
              'x-bos-id-token': await idTokenFor('founder', { audience: '999999999999999999' }),
            },
          }),
        ],
        [
          'an ID token signed with a key the issuer does not publish',
          async () => ({
            headers: { 'x-bos-id-token': await idTokenFor('founder', { signWith: 'forged' }) },
          }),
        ],
        [
          // The verifier lets an ID token past its `exp` still prove a sign-in for up to 24 h (the BFF
          // holds one for the whole session), so only an `exp` older than that is refused.
          'an ID token that expired more than 24 h ago',
          async () => ({
            headers: {
              'x-bos-id-token': await idTokenFor('founder', { exp: nowSeconds() - 2 * 86_400 }),
            },
          }),
        ],
        [
          'an ID token from a foreign issuer',
          async () => ({
            headers: {
              'x-bos-id-token': await idTokenFor('founder', {
                issuer: 'https://evil.example.test',
              }),
            },
          }),
        ],
        [
          'an unreadable x-bos-id-token',
          () => Promise.resolve({ headers: { 'x-bos-id-token': 'not-a-jwt' } }),
        ],
      ];

    it.each(refused)('%s', async (_name, build) => {
      const { headers, access } = await build();
      const res = await approve(access ?? (await auth('founder')), s.requestId, s.version, headers);
      expectStepUpRequired(res);

      // Nothing was decided: the step, the version and the action rows are as step 2 left them.
      const request = await getRequest(await auth('founder'), s.requestId);
      expect(request).toMatchObject({ status: 'pending', currentSeq: 4, version: s.version });
      expect(await approveRows(s.requestId)).toBe(3);
    });
  });

  it('4. a fresh ID token for the same user decides the Founder step (200) and the request is approved', async () => {
    const founder = await auth('founder');
    const res = await approve(founder, s.requestId, s.version, {
      'x-bos-id-token': await idTokenFor('founder'),
    });
    expect(res.status, show(res)).toBe(200);
    const dto = ApprovalRequestDtoSchema.parse(res.body);
    expect(dto.status).toBe('approved');
    expect(dto.decidedAt).not.toBeNull();
    expect(dto.version).toBeGreaterThan(s.version);

    expect(await approveRows(s.requestId)).toBe(4);
    const after = await getRequest(founder, s.requestId);
    expect(after.status).toBe('approved');
  });
});
