import { describe, expect, it, vi } from 'vitest';

import {
  ACCESS_TOKEN_LIFETIME,
  BOOTSTRAP_SA_USER,
  DEFAULT_ADMIN_USERNAME,
  DEFAULT_WEBHOOK_URL,
  finalizeBootstrap,
  FOUNDER_ORG_ROLE,
  LOADTEST_APPROVER_USER,
  PORTAL_APP_NAME,
  PORTAL_ENV_FILE,
  PROVISIONER_IAM_ROLES,
  PROVISIONER_ROLES,
  PROVISIONER_USER,
  retireBootstrapAdmin,
  runSeed,
  SEED_TOOL,
  TOTP_METHOD,
  WEBHOOK_TARGET_NAME,
  type IdpOrgSeed,
  type SeedApi,
  type SeedDeps,
  type TenancySeed,
  type TenancyStore,
} from './index.js';
import type { DevPersona } from './db-seed.js';
import { type DevFiles, parseEnv } from './outputs.js';
import {
  EXTRA_VENDORS,
  ORG_NAMES,
  PERSONAS,
  PROJECT_ROLES,
  personaUsername,
  type PersonaEntry,
} from './personas.js';
import { totpCode } from './totp.js';
import { PORTAL_LOGIN_POLICY } from './zitadel-client.js';
import type {
  AppInfo,
  AuthorizationInfo,
  CreatedPat,
  CreatedTarget,
  ExecutionCondition,
  GrantInfo,
  HumanSpec,
  LoginPolicy,
  MachineSpec,
  OidcAppSpec,
  OidcSettings,
  OrgLoginPolicyPatch,
  PatInfo,
  ProjectInfo,
  SecondFactorType,
  SmtpSpec,
  TargetInfo,
  TargetSpec,
  TotpRegistration,
  UserInfo,
} from './zitadel-client.js';

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** The seed's clock in tests: a fixed instant, so the fake can check the exact TOTP code. */
const NOW = new Date('2026-11-08T10:00:00Z');

/** RFC 4648 base32 without padding, the form ZITADEL returns TOTP secrets in. */
function base32(bytes: Buffer): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}

/**
 * In-memory ZITADEL. Every method that changes state bumps `mutations`, so a test can assert that a
 * second run made no mutating call at all (stronger than checking the printed message).
 */
class FakeZitadel implements SeedApi {
  mutations = 0;
  secretsIssued = 0;
  passwordResets = 0;
  /** Ordered P1 calls (`name:userId`), so tests can check that forceMfa comes last. */
  readonly calls: string[] = [];
  /** TOTP secret ZITADEL handed out per user id (pending until verified). */
  readonly totpIssued = new Map<string, string>();
  /** Verification throws for this username, to simulate a half-run. */
  failVerifyFor: string | undefined;
  loginPolicy: LoginPolicy = {
    forceMfa: false,
    forceMfaLocalOnly: false,
    mfaInitSkipLifetime: '720h',
  };
  readonly secondFactors = new Set<SecondFactorType>();
  oidc: OidcSettings = { accessTokenLifetime: '43200s', idTokenLifetime: '43200s' };
  private readonly totpVerified = new Set<string>();
  readonly pats = new Map<string, PatInfo[]>();
  readonly targets: TargetInfo[] = [];
  readonly deactivated = new Set<string>();
  patsIssued = 0;
  tokenClaims: Record<string, unknown> | undefined;
  appTokenType = 'OIDC_TOKEN_TYPE_JWT';
  /** Per app name; wins over appTokenType. */
  readonly appTokenTypes = new Map<string, string>();
  private seq = 0;
  private readonly orgs = new Map<string, string>(); // name -> id
  private readonly projects = new Map<
    string,
    { id: string; owner: string; assertion: boolean; authRequired: boolean }
  >();
  private readonly roles = new Set<string>();
  private readonly grants = new Map<string, string[]>(); // org id -> roles
  /** OIDC apps by name, with the spec they were created from. Client ids count up from client-1. */
  readonly apps = new Map<string, AppInfo & { spec: OidcAppSpec }>();
  /** Every setOidcAppRedirects call, so a test can see the full lists the seed sent. */
  readonly redirectUpdates: { appId: string; redirectUris: string[]; postLogout: string[] }[] = [];
  private readonly users = new Map<string, UserInfo & { orgId: string; username: string }>();
  private readonly auths = new Map<string, { id: string; roles: string[] }>(); // user id -> auth
  readonly members = new Map<string, string[]>(); // `${org}:${user}` -> roles
  readonly iamMembers = new Map<string, string[]>(); // user -> instance roles
  private smtp = false;
  private instancePasswordReset = false;
  /** Every call, changing or not, so a test can see what the seed asked for. */
  readonly authRequiredCalls: string[] = [];
  readonly noRegisterCalls: string[] = [];
  private readonly noRegisterOrgs = new Set<string>();
  readonly staffOrgId = 'staff-org';

  private id(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }
  private mutate(): void {
    this.mutations += 1;
  }
  /** Test helper: a user that exists before the seed runs (no mutation is counted). */
  preexisting(orgId: string, username: string): string {
    const user = { id: this.id('user'), preferredLoginName: username, hasSecret: false };
    this.users.set(user.id, { ...user, orgId, username });
    return user.id;
  }
  /** Test helper: the id of the user with this username. */
  userIdOf(username: string): string {
    const user = [...this.users.values()].find((u) => u.username === username);
    if (!user) throw new Error(`no user ${username}`);
    return user.id;
  }

  /** Test helper: the org of the user with this username. */
  orgIdOfUser(username: string): string | undefined {
    return [...this.users.values()].find((u) => u.username === username)?.orgId;
  }
  /** Test helper: the roles the project is granted to this org with. */
  grantRolesOf(orgId: string): string[] | undefined {
    return this.grants.get(orgId);
  }

  getDefaultOrgId(): Promise<string> {
    return Promise.resolve(this.staffOrgId);
  }
  findOrgByName(name: string): Promise<string | undefined> {
    return Promise.resolve(this.orgs.get(name));
  }
  createOrg(name: string): Promise<string> {
    this.mutate();
    const id = this.id('org');
    this.orgs.set(name, id);
    return Promise.resolve(id);
  }
  findProject(owner: string, name: string): Promise<ProjectInfo | undefined> {
    const p = this.projects.get(name);
    return Promise.resolve(
      p && p.owner === owner
        ? {
            id: p.id,
            projectRoleAssertion: p.assertion,
            authorizationRequired: p.authRequired,
          }
        : undefined,
    );
  }
  createProject(owner: string, name: string): Promise<string> {
    this.mutate();
    const id = this.id('project');
    this.projects.set(name, { id, owner, assertion: true, authRequired: true });
    return Promise.resolve(id);
  }
  /** Test hook: put the project back in the state ZITADEL creates it in by default. */
  resetAuthorizationRequired(): void {
    for (const p of this.projects.values()) p.authRequired = false;
  }
  enableAuthorizationRequired(projectId: string): Promise<void> {
    this.authRequiredCalls.push(projectId);
    this.mutate();
    for (const p of this.projects.values()) if (p.id === projectId) p.authRequired = true;
    return Promise.resolve();
  }
  ensureInstancePasswordReset(): Promise<boolean> {
    if (this.instancePasswordReset) return Promise.resolve(false);
    this.mutate();
    this.instancePasswordReset = true;
    return Promise.resolve(true);
  }
  ensureStaffLoginPolicy(orgId: string): Promise<boolean> {
    this.noRegisterCalls.push(orgId);
    if (this.noRegisterOrgs.has(orgId)) return Promise.resolve(false);
    this.mutate();
    this.noRegisterOrgs.add(orgId);
    return Promise.resolve(true);
  }
  /** Every call, changing or not, with the patch it asked for. */
  readonly portalPolicyCalls: { orgId: string; patch: OrgLoginPolicyPatch }[] = [];
  private readonly pinnedPolicies = new Map<string, OrgLoginPolicyPatch>();
  ensureOrgLoginPolicy(orgId: string, patch: OrgLoginPolicyPatch): Promise<boolean> {
    this.portalPolicyCalls.push({ orgId, patch });
    this.calls.push(`ensureOrgLoginPolicy:${orgId}`);
    const pinned = this.pinnedPolicies.get(orgId);
    if (pinned && JSON.stringify(pinned) === JSON.stringify(patch)) return Promise.resolve(false);
    this.mutate();
    this.pinnedPolicies.set(orgId, { ...patch });
    return Promise.resolve(true);
  }
  enableRoleAssertion(): Promise<void> {
    this.mutate();
    for (const p of this.projects.values()) p.assertion = true;
    return Promise.resolve();
  }
  listProjectRoles(): Promise<string[]> {
    return Promise.resolve([...this.roles]);
  }
  addProjectRole(_p: string, key: string): Promise<void> {
    this.mutate();
    this.roles.add(key);
    return Promise.resolve();
  }
  listProjectGrants(): Promise<GrantInfo[]> {
    return Promise.resolve(
      [...this.grants].map(([grantedOrgId, roleKeys]) => ({ grantedOrgId, roleKeys })),
    );
  }
  createProjectGrant(_p: string, org: string, roleKeys: string[]): Promise<void> {
    this.mutate();
    this.grants.set(org, roleKeys);
    return Promise.resolve();
  }
  updateProjectGrant(_p: string, org: string, roleKeys: string[]): Promise<void> {
    this.mutate();
    this.grants.set(org, roleKeys);
    return Promise.resolve();
  }
  findOidcApp(_p: string, name: string): Promise<AppInfo | undefined> {
    const app = this.apps.get(name);
    return Promise.resolve(
      app && {
        id: app.id,
        clientId: app.clientId,
        accessTokenType: this.appTokenTypes.get(name) ?? this.appTokenType,
        redirectUris: [...app.redirectUris],
        postLogoutRedirectUris: [...app.postLogoutRedirectUris],
      },
    );
  }
  createOidcApp(_p: string, spec: OidcAppSpec): Promise<AppInfo> {
    this.mutate();
    const app = {
      id: this.id('app'),
      clientId: `client-${this.apps.size + 1}`,
      accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
      redirectUris: [...spec.redirectUris],
      postLogoutRedirectUris: [...spec.postLogoutRedirectUris],
      spec,
    };
    this.apps.set(spec.name, app);
    return Promise.resolve(app);
  }
  setOidcAppRedirects(
    _p: string,
    appId: string,
    uris: Pick<OidcAppSpec, 'redirectUris' | 'postLogoutRedirectUris'>,
  ): Promise<void> {
    this.mutate();
    this.redirectUpdates.push({
      appId,
      redirectUris: uris.redirectUris,
      postLogout: uris.postLogoutRedirectUris,
    });
    for (const app of this.apps.values()) {
      if (app.id !== appId) continue;
      app.redirectUris = [...uris.redirectUris];
      app.postLogoutRedirectUris = [...uris.postLogoutRedirectUris];
    }
    return Promise.resolve();
  }
  findUser(orgId: string, username: string): Promise<UserInfo | undefined> {
    const user = [...this.users.values()].find((u) => u.orgId === orgId && u.username === username);
    return Promise.resolve(user);
  }
  createHumanUser(spec: HumanSpec): Promise<UserInfo> {
    this.mutate();
    const user = {
      id: this.id('user'),
      preferredLoginName: spec.username,
      hasSecret: false,
      orgId: spec.orgId,
      username: spec.username,
    };
    this.users.set(user.id, user);
    return Promise.resolve(user);
  }
  createMachineUser(spec: MachineSpec): Promise<UserInfo> {
    this.mutate();
    const user = {
      id: this.id('user'),
      preferredLoginName: spec.username,
      hasSecret: false,
      orgId: spec.orgId,
      username: spec.username,
    };
    this.users.set(user.id, user);
    return Promise.resolve(user);
  }
  setPassword(): Promise<void> {
    this.mutate();
    this.passwordResets += 1;
    return Promise.resolve();
  }
  addSecret(userId: string): Promise<string> {
    this.mutate();
    this.secretsIssued += 1;
    const user = this.users.get(userId);
    if (user) user.hasSecret = true;
    return Promise.resolve(`secret-${this.secretsIssued}`);
  }
  findAuthorization(userId: string): Promise<AuthorizationInfo | undefined> {
    const a = this.auths.get(userId);
    return Promise.resolve(a && { id: a.id, roleKeys: a.roles });
  }
  createAuthorization(userId: string, _p: string, _o: string, roleKeys: string[]): Promise<void> {
    this.mutate();
    this.auths.set(userId, { id: this.id('auth'), roles: roleKeys });
    return Promise.resolve();
  }
  updateAuthorization(authorizationId: string, roleKeys: string[]): Promise<void> {
    this.mutate();
    for (const a of this.auths.values()) if (a.id === authorizationId) a.roles = roleKeys;
    return Promise.resolve();
  }
  listOrgMemberRoles(orgId: string, userId: string): Promise<string[] | undefined> {
    return Promise.resolve(this.members.get(`${orgId}:${userId}`));
  }
  addOrgMember(orgId: string, userId: string, roles: string[]): Promise<void> {
    this.mutate();
    this.members.set(`${orgId}:${userId}`, roles);
    return Promise.resolve();
  }
  listIamMemberRoles(userId: string): Promise<string[] | undefined> {
    return Promise.resolve(this.iamMembers.get(userId));
  }
  addIamMember(userId: string, roles: string[]): Promise<void> {
    this.mutate();
    this.iamMembers.set(userId, roles);
    return Promise.resolve();
  }
  ensureSmtp(_spec: SmtpSpec): Promise<boolean> {
    if (this.smtp) return Promise.resolve(false);
    this.mutate();
    this.smtp = true;
    return Promise.resolve(true);
  }
  clientCredentialsToken(): Promise<string> {
    const project = this.projects.get('business-os');
    const claims = this.tokenClaims ?? {
      iss: 'https://auth.localhost',
      sub: 'machine-1',
      aud: [project?.id ?? 'x', 'client-1'],
      // ZITADEL client credentials: the client is the machine user's username (Basic auth).
      client_id: 'bos-loadtest',
      'urn:zitadel:iam:org:project:roles': { sales: { [this.staffOrgId]: 'staff.localhost' } },
      'urn:zitadel:iam:user:resourceowner:id': this.staffOrgId,
    };
    return Promise.resolve(`${b64({ alg: 'RS256' })}.${b64(claims)}.sig`);
  }

  // ---- ZitadelP1Api ----
  registerTotp(userId: string): Promise<TotpRegistration> {
    this.mutate();
    this.calls.push(`registerTotp:${userId}`);
    // 20 bytes like ZITADEL's secrets; unique per user and per registration.
    const secret = base32(Buffer.from(`totp:${userId}:${this.mutations}`.padEnd(20, '#')));
    this.totpIssued.set(userId, secret);
    return Promise.resolve({ uri: `otpauth://totp/bos:${userId}?secret=${secret}`, secret });
  }
  verifyTotpRegistration(userId: string, code: string): Promise<void> {
    this.mutate();
    this.calls.push(`verifyTotp:${userId}`);
    const user = this.users.get(userId);
    if (user && user.username === this.failVerifyFor) {
      return Promise.reject(new Error('fake: verification failed'));
    }
    const secret = this.totpIssued.get(userId);
    if (!secret || code !== totpCode(secret, NOW)) {
      return Promise.reject(new Error('fake: invalid TOTP code'));
    }
    this.totpVerified.add(userId);
    return Promise.resolve();
  }
  listAuthMethods(userId: string): Promise<string[]> {
    const methods = ['AUTHENTICATION_METHOD_TYPE_PASSWORD'];
    if (this.totpVerified.has(userId)) methods.push(TOTP_METHOD);
    return Promise.resolve(methods);
  }
  getLoginPolicy(): Promise<LoginPolicy> {
    return Promise.resolve({ ...this.loginPolicy });
  }
  updateLoginPolicy(patch: LoginPolicy): Promise<boolean> {
    if (Object.entries(patch).every(([k, v]) => this.loginPolicy[k] === v)) {
      return Promise.resolve(false);
    }
    this.mutate();
    this.calls.push(`updateLoginPolicy:forceMfa=${String(patch.forceMfa)}`);
    this.loginPolicy = { ...this.loginPolicy, ...patch };
    return Promise.resolve(true);
  }
  addSecondFactor(type: SecondFactorType): Promise<boolean> {
    if (this.secondFactors.has(type)) return Promise.resolve(false);
    this.mutate();
    this.calls.push(`addSecondFactor:${type}`);
    this.secondFactors.add(type);
    return Promise.resolve(true);
  }
  getOidcSettings(): Promise<OidcSettings> {
    return Promise.resolve({ ...this.oidc });
  }
  updateOidcSettings(patch: OidcSettings): Promise<boolean> {
    if (Object.entries(patch).every(([k, v]) => this.oidc[k] === v)) return Promise.resolve(false);
    this.mutate();
    this.oidc = { ...this.oidc, ...patch };
    return Promise.resolve(true);
  }
  // Part 2 (B1b) steps use these; simple in-memory versions so the fake is complete.
  addPat(userId: string, expirationDate: string): Promise<CreatedPat> {
    this.mutate();
    this.patsIssued += 1;
    this.calls.push(`addPat:${userId}:${expirationDate}`);
    const tokenId = this.id('pat');
    this.pats.set(userId, [...(this.pats.get(userId) ?? []), { id: tokenId, expirationDate }]);
    return Promise.resolve({ tokenId, token: `pat-token-${tokenId}` });
  }
  listPats(userId: string): Promise<PatInfo[]> {
    return Promise.resolve(this.pats.get(userId) ?? []);
  }
  createTarget(spec: TargetSpec): Promise<CreatedTarget> {
    this.mutate();
    const id = this.id('target');
    this.targets.push({ id, name: spec.name, endpoint: spec.endpoint });
    return Promise.resolve({ id, signingKey: `signing-${id}` });
  }
  listTargets(): Promise<TargetInfo[]> {
    return Promise.resolve([...this.targets]);
  }
  setExecution(): Promise<void> {
    this.mutate();
    return Promise.resolve();
  }
  // An idempotent PUT the seed sends on every run: recorded in `calls`, not counted as a mutation.
  setUserEventExecution(targetId: string): Promise<ExecutionCondition> {
    this.calls.push(`setUserEventExecution:${targetId}`);
    return Promise.resolve({ event: { group: 'user' } });
  }
  deactivateUser(userId: string): Promise<boolean> {
    if (this.deactivated.has(userId)) return Promise.resolve(false);
    this.mutate();
    this.deactivated.add(userId);
    return Promise.resolve(true);
  }
}

class FakeFiles implements DevFiles {
  readonly data = new Map<string, string>();
  writes = 0;
  read(name: string): Promise<string | undefined> {
    return Promise.resolve(this.data.get(name));
  }
  write(name: string, content: string): Promise<boolean> {
    if (this.data.get(name) === content) return Promise.resolve(false);
    this.data.set(name, content);
    this.writes += 1;
    return Promise.resolve(true);
  }
}

/** Mimics the SQL: first call inserts, later identical calls change nothing. */
class FakeStore implements TenancyStore {
  entity: TenancySeed['entity'] | undefined;
  /** idp_orgs by ZITADEL org id, each with its party (null for staff). */
  rows = new Map<string, IdpOrgSeed>();
  /** Staff org id passed to each seedKernel call; the first call seeds 5 rows, later ones 0. */
  readonly kernelCalls: string[] = [];
  /** The dev personas passed to each seedKernel call. */
  readonly kernelPersonas: (readonly DevPersona[] | undefined)[] = [];
  seedKernel(
    staffZitadelOrgId: string,
    _correlationId: string,
    personas?: readonly DevPersona[],
  ): Promise<number> {
    this.kernelCalls.push(staffZitadelOrgId);
    this.kernelPersonas.push(personas);
    return Promise.resolve(this.kernelCalls.length === 1 ? 5 : 0);
  }
  upsertTenancy(seed: TenancySeed): Promise<number> {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    let changed = same(this.entity, seed.entity) ? 0 : 1;
    this.entity = seed.entity;
    for (const org of seed.idpOrgs) {
      if (!same(this.rows.get(org.zitadelOrgId), org)) changed += 1;
      this.rows.set(org.zitadelOrgId, org);
    }
    return Promise.resolve(changed);
  }
}

function setup(): {
  api: FakeZitadel;
  files: FakeFiles;
  store: FakeStore;
  deps: SeedDeps;
  logs: string[];
} {
  const api = new FakeZitadel();
  // What ZITADEL's first-instance setup creates in the staff org before any seed run.
  api.preexisting(api.staffOrgId, DEFAULT_ADMIN_USERNAME);
  api.preexisting(api.staffOrgId, BOOTSTRAP_SA_USER);
  const files = new FakeFiles();
  const store = new FakeStore();
  const logs: string[] = [];
  const deps: SeedDeps = {
    api,
    files,
    store,
    log: (line) => logs.push(line),
    issuer: 'https://auth.localhost',
    workspaceUrl: 'https://app.localhost',
    now: () => NOW,
    configureDevMailpit: true,
  };
  return { api, files, store, deps, logs };
}

const personasOf = (files: FakeFiles): PersonaEntry[] =>
  JSON.parse(files.data.get('personas.json') ?? '[]') as PersonaEntry[];

describe('@bos/seed-zitadel', () => {
  it('exports its tool name', () => {
    expect(SEED_TOOL).toBe('@bos/seed-zitadel');
  });

  it('first run creates everything and writes the dev files', async () => {
    const { api, files, store, deps } = setup();
    const result = await runSeed(deps);

    expect(result.changes.length).toBeGreaterThan(10);
    expect(result.warnings).toEqual([]);
    expect(await api.listProjectRoles()).toHaveLength(PROJECT_ROLES.length);
    expect(await api.listProjectRoles()).toContain('accountant');
    expect([...files.data.keys()].sort()).toEqual([
      'k6.env',
      'personas.json',
      'zitadel-api.env',
      'zitadel.env',
    ]);
    expect(files.data.get('zitadel.env')).toContain('OIDC_CLIENT_ID=client-1');
    // zitadel.env is read by the web apps too: ids only, no TOKEN or KEY entry (U1-01).
    for (const key of Object.keys(parseEnv(files.data.get('zitadel.env')))) {
      expect(key).not.toMatch(/TOKEN|KEY|SECRET|PASSWORD/);
    }
    expect(Object.keys(parseEnv(files.data.get('zitadel-api.env'))).sort()).toEqual([
      'ZITADEL_ACTIONS_SIGNING_KEY',
      'ZITADEL_PROVISIONER_TOKEN',
    ]);
    // The API's azp allow-list: the workspace app plus both k6 machine users, or the perf gates get 401.
    expect(parseEnv(files.data.get('zitadel.env'))['OIDC_ALLOWED_AZP']).toBe(
      'client-1,bos-loadtest,bos-loadtest-approver',
    );
    expect(result.token.clientId).toBe('bos-loadtest');
    expect(files.data.get('k6.env')).toContain('K6_CLIENT_ID=bos-loadtest\n');
    expect(files.data.get('k6.env')).toContain(`K6_APPROVER_CLIENT_ID=${LOADTEST_APPROVER_USER}\n`);
    expect(files.data.get('k6.env')).toMatch(/^K6_APPROVER_CLIENT_SECRET=secret-\d+$/m);
    expect(store.rows.size).toBe(5);
    // ADR 0027 section 11: one TR entity; the customer and vendor IdP orgs carry their parties.
    expect(store.entity).toEqual({ code: 'TR', name: 'Techrida', legalName: 'Techrida Pvt. Ltd.' });
    expect([...store.rows.values()].map((o) => [o.kind, o.party?.code ?? null])).toEqual([
      ['staff', null],
      ['customer', 'CUST-DEV'],
      ['vendor', 'VEND-DEV'],
      ['vendor', 'VEND-DEV2'],
      ['vendor', 'VEND-DEVKYC'],
    ]);
    expect(PERSONAS).toHaveLength(20);
    const personas = personasOf(files);
    expect(personas).toHaveLength(20);
    // The Marketing department people hold the marketing project role.
    const marketingHead = await api.findAuthorization(
      api.userIdOf(personaUsername('marketinghead')),
    );
    expect(marketingHead?.roleKeys).toEqual(['marketing']);
    expect(personas.map((p) => p.username)).toContain('accountant@dev.bos.test');
    // Both k6 machine users got a secret; the approver holds exactly the accountant role.
    expect(api.secretsIssued).toBe(2);
    const approverAuth = await api.findAuthorization(api.userIdOf(LOADTEST_APPROVER_USER));
    expect(approverAuth?.roleKeys).toEqual(['accountant']);
    const accountantAuth = await api.findAuthorization(api.userIdOf(personaUsername('accountant')));
    expect(accountantAuth?.roleKeys).toEqual(['accountant']);
    // Login policy and token lifetime.
    expect(api.secondFactors.has('SECOND_FACTOR_TYPE_OTP')).toBe(true);
    expect(api.loginPolicy.forceMfa).toBe(true);
    expect(api.loginPolicy.mfaInitSkipLifetime).toBe('0s');
    expect(api.oidc.accessTokenLifetime).toBe(ACCESS_TOKEN_LIFETIME);
    expect(api.oidc.idTokenLifetime).toBe('43200s');
  });

  it('registers TOTP per persona, verifies with that secret, and persists it', async () => {
    const { api, files, deps } = setup();
    await runSeed(deps);

    const personas = personasOf(files);
    for (const p of personas) {
      const userId = api.userIdOf(p.username);
      // The fake only marks TOTP verified when the code is totpCode(issued secret, NOW).
      expect(await api.listAuthMethods(userId)).toContain(TOTP_METHOD);
      expect(p.totpSecret).toBe(api.totpIssued.get(userId));
      expect(p.totpSecret).toMatch(/^[A-Z2-7]{32}$/);
    }
    expect(api.calls.filter((c) => c.startsWith('verifyTotp:'))).toHaveLength(20);
  });

  it('enables forceMfa only after every persona has TOTP, and OTP before any registration', async () => {
    const { api, deps } = setup();
    await runSeed(deps);

    const force = api.calls.indexOf('updateLoginPolicy:forceMfa=true');
    const lastVerify = api.calls.findLastIndex((c) => c.startsWith('verifyTotp:'));
    const firstRegister = api.calls.findIndex((c) => c.startsWith('registerTotp:'));
    expect(force).toBeGreaterThan(lastVerify);
    expect(api.calls.indexOf('addSecondFactor:SECOND_FACTOR_TYPE_OTP')).toBeLessThan(firstRegister);
  });

  it('a half-run keeps forceMfa off and the secrets it already verified; the next run finishes', async () => {
    const { api, files, deps } = setup();
    api.failVerifyFor = personaUsername('finance');
    await expect(runSeed(deps)).rejects.toThrow(/verification failed/);

    expect(api.loginPolicy.forceMfa).toBe(false);
    expect(api.calls.some((c) => c.startsWith('updateLoginPolicy:'))).toBe(false);
    const saved = new Map(personasOf(files).map((p) => [p.key, p.totpSecret]));
    // PERSONAS order: founder and management come before finance.
    expect(saved.get('founder')).toBe(api.totpIssued.get(api.userIdOf(personaUsername('founder'))));
    expect(saved.get('management')).toBeDefined();
    expect(saved.get('finance')).toBeUndefined();

    api.failVerifyFor = undefined;
    const result = await runSeed(deps);
    expect(result.warnings).toEqual([]);
    expect(api.loginPolicy.forceMfa).toBe(true);
    const after = new Map(personasOf(files).map((p) => [p.key, p.totpSecret]));
    expect(after.get('founder')).toBe(saved.get('founder'));
    expect(after.get('finance')).toBeDefined();
  });

  it('configures Mailpit only for an opted-in development seed', async () => {
    const { api, deps } = setup();
    const configureMail = vi.spyOn(api, 'ensureSmtp');
    await runSeed({ ...deps, configureDevMailpit: false });
    expect(configureMail).not.toHaveBeenCalled();

    await runSeed(deps);
    expect(configureMail).toHaveBeenCalledWith(expect.objectContaining({ host: 'mailpit:1025' }));
  });

  it('second run makes no mutating call and reports no changes', async () => {
    const { api, files, deps } = setup();
    await runSeed(deps);
    const mutationsAfterFirst = api.mutations;
    const k6EnvAfterFirst = files.data.get('k6.env');
    const personasAfterFirst = files.data.get('personas.json');
    const writesAfterFirst = files.writes;

    const second = await runSeed(deps);

    expect(second.changes).toEqual([]);
    expect(second.warnings).toEqual([]);
    expect(api.mutations).toBe(mutationsAfterFirst);
    expect(api.secretsIssued).toBe(2); // neither k6 client secret may rotate
    expect(files.writes).toBe(writesAfterFirst);
    expect(files.data.get('k6.env')).toBe(k6EnvAfterFirst);
    expect(files.data.get('personas.json')).toBe(personasAfterFirst);
  });

  it('enables "check for authorization on authentication" on an existing project that lacks it (CR-02)', async () => {
    const { api, deps, logs } = setup();
    await runSeed(deps);
    api.resetAuthorizationRequired();
    api.authRequiredCalls.length = 0;
    logs.length = 0;

    const result = await runSeed(deps);

    expect(api.authRequiredCalls).toHaveLength(1);
    expect(api.authRequiredCalls[0]).toMatch(/^project-/);
    expect(result.changes).toEqual(['enabled "check for authorization on authentication"']);
    expect(logs).toContain('  + enabled "check for authorization on authentication"');
  });

  it('disables self-registration on the staff org (CR-02)', async () => {
    const { api, deps } = setup();
    const result = await runSeed(deps);

    expect(api.noRegisterCalls).toEqual([api.staffOrgId]);
    expect(result.changes).toContain(
      'configured staff login policy for invitations and private password reset',
    );
  });

  it('is idempotent for authorization and self-registration (CR-02)', async () => {
    const { api, deps } = setup();
    await runSeed(deps);
    const mutationsAfterFirst = api.mutations;
    const authCallsAfterFirst = api.authRequiredCalls.length;

    const second = await runSeed(deps);

    expect(second.changes).toEqual([]);
    expect(api.mutations).toBe(mutationsAfterFirst);
    expect(api.authRequiredCalls).toHaveLength(authCallsAfterFirst); // a new project is created with it on
    expect(api.noRegisterCalls).toEqual([api.staffOrgId, api.staffOrgId]); // asked again, changed nothing
  });

  it('pins the portal login policy on the customer org only, after every persona has TOTP', async () => {
    const { api, deps } = setup();
    const result = await runSeed(deps);

    const customerOrgId = await api.findOrgByName(ORG_NAMES.customer);
    expect(customerOrgId).toBeDefined();
    expect(api.portalPolicyCalls).toEqual([{ orgId: customerOrgId, patch: PORTAL_LOGIN_POLICY }]);
    expect(PORTAL_LOGIN_POLICY).toEqual({
      allowRegister: false,
      forceMfa: true,
      forceMfaLocalOnly: false,
      mfaInitSkipLifetime: '0s',
    });
    expect(result.changes).toContain('pinned the portal login policy on the customer org');
    const pin = api.calls.indexOf(`ensureOrgLoginPolicy:${customerOrgId}`);
    expect(pin).toBeGreaterThan(api.calls.findLastIndex((c) => c.startsWith('verifyTotp:')));
  });

  it('gives the second approved vendor and the vendor awaiting KYC an org, a project grant, a login and a switcher label each', async () => {
    const { api, files, deps } = setup();
    const result = await runSeed(deps);

    const devVendorOrg = await api.findOrgByName(ORG_NAMES.vendor);
    const orgs = new Set<string | undefined>([devVendorOrg]);
    for (const extra of EXTRA_VENDORS) {
      const orgId = await api.findOrgByName(extra.orgName);
      expect(orgId, extra.orgName).toBeDefined();
      orgs.add(orgId);
      expect(result.changes).toContain(`created organization "${extra.orgName}"`);
      // The vendor role only, like Dev Vendor Co.
      expect(api.grantRolesOf(orgId ?? ''), extra.orgName).toEqual(['vendor_user']);
      const username = personaUsername(extra.key);
      expect(api.orgIdOfUser(username)).toBe(orgId);
      const auth = await api.findAuthorization(api.userIdOf(username));
      expect(auth?.roleKeys).toEqual(['vendor_user']);
    }
    expect(orgs.size).toBe(3);
    // The shared Dev Vendor Co login did not move.
    expect(api.orgIdOfUser(personaUsername('vendor'))).toBe(devVendorOrg);

    // The switcher and `logins` read plain role labels, and each new persona has TOTP and a password.
    const entries = personasOf(files);
    const byKey = new Map(entries.map((p) => [p.key, p]));
    expect(byKey.get('vendor2')?.label).toBe('Vendor 2 (approved)');
    expect(byKey.get('vendorpending')?.label).toBe('Vendor awaiting KYC');
    expect(byKey.get('vendor')?.label).toBe('Dev Vendor');
    for (const key of ['vendor2', 'vendorpending']) {
      expect(byKey.get(key)?.orgKind, key).toBe('vendor');
      expect(byKey.get(key)?.totpSecret, key).toMatch(/^[A-Z2-7]{32}$/);
    }

    // A second run changes nothing, orgs and grants included.
    expect((await runSeed(deps)).changes).toEqual([]);
  });

  it('a half-run does not pin the portal login policy; the next run does', async () => {
    const { api, deps } = setup();
    api.failVerifyFor = personaUsername('finance');
    await expect(runSeed(deps)).rejects.toThrow(/verification failed/);
    expect(api.portalPolicyCalls).toEqual([]);

    api.failVerifyFor = undefined;
    const result = await runSeed(deps);
    expect(api.portalPolicyCalls).toHaveLength(1);
    expect(result.changes).toContain('pinned the portal login policy on the customer org');
  });

  it('asks again on a second run but writes nothing', async () => {
    const { api, deps } = setup();
    await runSeed(deps);
    const mutations = api.mutations;

    const second = await runSeed(deps);

    expect(api.portalPolicyCalls).toHaveLength(2);
    expect(api.mutations).toBe(mutations);
    expect(second.changes).toEqual([]);
  });

  it('keeps persona passwords across runs and never logs secrets', async () => {
    const { files, deps, logs } = setup();
    await runSeed(deps);
    const before = files.data.get('personas.json') ?? '';
    await runSeed(deps);
    expect(files.data.get('personas.json')).toBe(before);

    const entries = JSON.parse(before) as PersonaEntry[];
    const secrets = entries.flatMap((p) => [p.password, p.totpSecret ?? 'missing-totp']);
    const apiEnv = files.data.get('zitadel-api.env') ?? '';
    secrets.push(/^ZITADEL_PROVISIONER_TOKEN=(.*)$/m.exec(apiEnv)?.[1] ?? 'missing');
    secrets.push(/^ZITADEL_ACTIONS_SIGNING_KEY=(.*)$/m.exec(apiEnv)?.[1] ?? 'missing');
    const k6 = files.data.get('k6.env') ?? '';
    secrets.push(/^K6_CLIENT_SECRET=(.*)$/m.exec(k6)?.[1] ?? 'missing');
    secrets.push(/^K6_APPROVER_CLIENT_SECRET=(.*)$/m.exec(k6)?.[1] ?? 'missing');
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThan(5);
      for (const line of logs) expect(line).not.toContain(secret);
    }
  });

  it('resets passwords and loudly reports lost TOTP secrets when personas.json is lost', async () => {
    const { api, files, deps } = setup();
    await runSeed(deps);
    const secretsBefore = api.secretsIssued;
    const registrationsBefore = api.calls.filter((c) => c.startsWith('registerTotp:')).length;
    files.data.delete('personas.json');

    const result = await runSeed(deps);

    expect(api.passwordResets).toBe(PERSONAS.length);
    expect(api.secretsIssued).toBe(secretsBefore);
    expect(result.changes.some((c) => c.includes('personas.json'))).toBe(true);
    // No remove-TOTP call exists, so the seed must not re-register; it names the manual step.
    expect(api.calls.filter((c) => c.startsWith('registerTotp:'))).toHaveLength(
      registrationsBefore,
    );
    expect(result.warnings).toHaveLength(PERSONAS.length);
    for (const w of result.warnings) expect(w).toMatch(/TOTP.*no secret.*Remove its authenticator/);
    expect(personasOf(files).every((p) => p.totpSecret === undefined)).toBe(true);
  });

  it('issues new client secrets only when k6.env lost them', async () => {
    const { api, files, deps } = setup();
    await runSeed(deps);
    files.data.delete('k6.env');
    await runSeed(deps);
    expect(api.secretsIssued).toBe(4);
  });

  it('fails when the app issues non-JWT tokens', async () => {
    const { api, deps } = setup();
    await runSeed(deps);
    api.appTokenType = 'OIDC_TOKEN_TYPE_BEARER';
    await expect(runSeed(deps)).rejects.toThrow(/expected JWT/);
  });

  it('fails R7 when the token has no project audience', async () => {
    const { api, deps } = setup();
    api.tokenClaims = {
      sub: 'm',
      aud: ['client-1'],
      'urn:zitadel:iam:org:project:roles': {},
      'urn:zitadel:iam:user:resourceowner:id': 'x',
    };
    await expect(runSeed(deps)).rejects.toThrow(/R7 failed.*aud does not contain/);
  });

  it('fails R7 when the k6 token client is not on the emitted azp allow-list', async () => {
    const { api, deps } = setup();
    api.tokenClaims = {
      sub: 'm',
      aud: ['client-1'],
      // A present azp wins over client_id, as in the API's jwt-verifier.
      azp: 'someone-else',
      client_id: 'bos-loadtest',
      'urn:zitadel:iam:org:project:roles': {},
      'urn:zitadel:iam:user:resourceowner:id': 'x',
    };
    await expect(runSeed(deps)).rejects.toThrow(
      /R7 failed.*token client "someone-else" is not in OIDC_ALLOWED_AZP/,
    );
  });

  describe('customer portal OIDC app (PORTAL_PUBLIC_URL)', () => {
    const portalUrl = 'https://portal.localhost';

    it('without a portal URL creates only the workspace app and no zitadel-portal.env', async () => {
      const { api, files, deps } = setup();
      await runSeed(deps);
      expect([...api.apps.keys()]).toEqual(['workspace']);
      expect(files.data.has(PORTAL_ENV_FILE)).toBe(false);
    });

    it('creates the portal app as a second app with its callback and writes its client id', async () => {
      const { api, files, deps } = setup();
      const result = await runSeed({ ...deps, portalUrl });

      expect(result.warnings).toEqual([]);
      expect([...api.apps.keys()]).toEqual(['workspace', PORTAL_APP_NAME]);
      const portal = api.apps.get(PORTAL_APP_NAME);
      // The same createOidcApp as the workspace: public PKCE client, JWT access tokens.
      expect(portal?.spec).toEqual({
        name: PORTAL_APP_NAME,
        redirectUris: ['https://portal.localhost/auth/callback'],
        postLogoutRedirectUris: ['https://portal.localhost/'],
      });
      expect(api.apps.get('workspace')?.spec.redirectUris).toEqual([
        'https://app.localhost/auth/callback',
      ]);
      expect(files.data.get(PORTAL_ENV_FILE)).toBe('OIDC_CLIENT_ID=client-2\n');
      // zitadel.env keeps the workspace client; the API also accepts the portal's tokens.
      const env = parseEnv(files.data.get('zitadel.env'));
      expect(env['OIDC_CLIENT_ID']).toBe('client-1');
      expect(env['OIDC_ALLOWED_AZP']).toBe('client-1,client-2,bos-loadtest,bos-loadtest-approver');
      expect(result.changes).toContain(`created OIDC app "${PORTAL_APP_NAME}"`);
      expect(result.changes).toContain(`wrote .dev/${PORTAL_ENV_FILE}`);
    });

    it('a re-run without a portal URL keeps an existing portal app in OIDC_ALLOWED_AZP and changes nothing else', async () => {
      const { api, files, deps } = setup();
      await runSeed({ ...deps, portalUrl });
      const mutationsAfterFirst = api.mutations;

      const second = await runSeed(deps);

      expect(second.changes).toEqual([]);
      expect(api.mutations).toBe(mutationsAfterFirst);
      expect(api.apps.size).toBe(2);
      expect(files.data.get(PORTAL_ENV_FILE)).toBe('OIDC_CLIENT_ID=client-2\n');
      const env = parseEnv(files.data.get('zitadel.env'));
      expect(env['OIDC_ALLOWED_AZP']).toBe('client-1,client-2,bos-loadtest,bos-loadtest-approver');
    });

    it('a second run with the same portal URL changes nothing', async () => {
      const { api, files, deps } = setup();
      await runSeed({ ...deps, portalUrl });
      const mutationsAfterFirst = api.mutations;
      const writesAfterFirst = files.writes;

      const second = await runSeed({ ...deps, portalUrl });

      expect(second.changes).toEqual([]);
      expect(api.mutations).toBe(mutationsAfterFirst);
      expect(files.writes).toBe(writesAfterFirst);
      expect(api.redirectUpdates).toEqual([]);
      expect(api.apps.size).toBe(2);
    });

    it('adds a missing redirect to an existing portal app and keeps the URIs already there', async () => {
      const { api, files, deps } = setup();
      await runSeed({ ...deps, portalUrl });

      const other = 'https://portal.r3-u10.localhost:59343';
      const result = await runSeed({ ...deps, portalUrl: other });

      const portal = api.apps.get(PORTAL_APP_NAME);
      expect(api.redirectUpdates).toEqual([
        {
          appId: portal?.id,
          redirectUris: [
            'https://portal.localhost/auth/callback',
            'https://portal.r3-u10.localhost:59343/auth/callback',
          ],
          postLogout: ['https://portal.localhost/', 'https://portal.r3-u10.localhost:59343/'],
        },
      ]);
      expect(result.changes).toEqual([
        `added ${other} to the redirect URIs of OIDC app "${PORTAL_APP_NAME}"`,
      ]);
      // Still the same app and client: nothing new to write.
      expect(api.apps.size).toBe(2);
      expect(files.data.get(PORTAL_ENV_FILE)).toBe('OIDC_CLIENT_ID=client-2\n');
    });

    it('fails when the portal app issues non-JWT tokens', async () => {
      const { api, deps } = setup();
      await runSeed({ ...deps, portalUrl });
      api.appTokenTypes.set(PORTAL_APP_NAME, 'OIDC_TOKEN_TYPE_BEARER');
      await expect(runSeed({ ...deps, portalUrl })).rejects.toThrow(
        /"Business OS portal" exists with access token type OIDC_TOKEN_TYPE_BEARER, expected JWT/,
      );
    });
  });

  describe('--finalize (production only)', () => {
    it('deactivates the bootstrap service account, then deletes admin.pat', async () => {
      const { api, deps } = setup();
      const result = await runSeed(deps);
      const removed: string[] = [];
      const done = await finalizeBootstrap({
        api,
        staffOrgId: result.staffOrgId,
        patFile: '/zitadel/admin/admin.pat',
        removeFile: (path) => {
          removed.push(path);
          return Promise.resolve();
        },
        log: () => undefined,
      });
      expect(api.deactivated.has(api.userIdOf(BOOTSTRAP_SA_USER))).toBe(true);
      expect(removed).toEqual(['/zitadel/admin/admin.pat']);
      expect(done).toEqual([
        `deactivated ${BOOTSTRAP_SA_USER}`,
        'deleted /zitadel/admin/admin.pat',
      ]);
    });

    it('keeps the file and fails when the bootstrap account is not found', async () => {
      const { api, deps } = setup();
      const result = await runSeed(deps);
      const removed: string[] = [];
      await expect(
        finalizeBootstrap({
          api,
          staffOrgId: `${result.staffOrgId}-elsewhere`,
          patFile: '/zitadel/admin/admin.pat',
          removeFile: (path) => {
            removed.push(path);
            return Promise.resolve();
          },
          log: () => undefined,
        }),
      ).rejects.toThrow(/not found/);
      expect(removed).toEqual([]);
    });

    it('keeps the file when the deactivate call fails, so the run can be repeated', async () => {
      const { api, deps } = setup();
      const result = await runSeed(deps);
      api.deactivateUser = () => Promise.reject(new Error('boom'));
      const removed: string[] = [];
      await expect(
        finalizeBootstrap({
          api,
          staffOrgId: result.staffOrgId,
          patFile: '/zitadel/admin/admin.pat',
          removeFile: (path) => {
            removed.push(path);
            return Promise.resolve();
          },
          log: () => undefined,
        }),
      ).rejects.toThrow('boom');
      expect(removed).toEqual([]);
    });
  });

  describe('P1 step 5: provisioner PAT', () => {
    it('grants both org roles, issues one PAT on the first run and reuses it after', async () => {
      const { api, files, deps } = setup();
      await runSeed(deps);
      const provisionerId = api.userIdOf(PROVISIONER_USER);
      expect(api.members.get(`${api.staffOrgId}:${provisionerId}`)).toEqual([...PROVISIONER_ROLES]);
      // K8 portal access: customer orgs, their users, project grants and org login policies.
      expect(PROVISIONER_IAM_ROLES).toEqual(['IAM_ORG_MANAGER']);
      expect(api.iamMembers.get(provisionerId)).toEqual(['IAM_ORG_MANAGER']);
      expect(api.patsIssued).toBe(1);
      // Expiry is now + 1 year, from the pinned clock.
      expect(api.calls).toContain(`addPat:${provisionerId}:2027-11-08T10:00:00.000Z`);
      const env = files.data.get('zitadel-api.env') ?? '';
      expect(env).toMatch(/^ZITADEL_PROVISIONER_TOKEN=pat-token-pat-\d+$/m);
      expect(files.data.get('zitadel.env')).not.toContain('ZITADEL_PROVISIONER_TOKEN');

      const second = await runSeed(deps);
      expect(second.changes).toEqual([]);
      expect(api.patsIssued).toBe(1);
      expect(files.data.get('zitadel-api.env')).toBe(env);
    });

    it('issues a new PAT when zitadel-api.env lost it or ZITADEL no longer lists one', async () => {
      const { api, files, deps } = setup();
      await runSeed(deps);
      files.data.delete('zitadel-api.env');
      await runSeed(deps);
      expect(api.patsIssued).toBe(2);

      api.pats.clear(); // as after `stack:nuke`: the stored token belongs to a dead user
      const result = await runSeed(deps);
      expect(api.patsIssued).toBe(3);
      expect(result.changes.some((c) => c.includes(`PAT for ${PROVISIONER_USER}`))).toBe(true);
    });

    it('warns instead of re-adding a member that lacks ORG_USER_PERMISSION_EDITOR', async () => {
      const { api, deps } = setup();
      const provisionerId = api.preexisting(api.staffOrgId, PROVISIONER_USER);
      api.members.set(`${api.staffOrgId}:${provisionerId}`, ['ORG_USER_MANAGER']);
      const result = await runSeed(deps);
      expect(api.members.get(`${api.staffOrgId}:${provisionerId}`)).toEqual(['ORG_USER_MANAGER']);
      expect(result.warnings).toEqual([
        expect.stringMatching(/without ORG_USER_PERMISSION_EDITOR.*Organization > Members/),
      ]);
    });
  });

  describe('provisioner instance role (K8 portal access)', () => {
    it('adds the instance role to an existing provisioner once (a P1 stack re-seeded)', async () => {
      const { api, deps } = setup();
      const provisionerId = api.preexisting(api.staffOrgId, PROVISIONER_USER);
      api.members.set(`${api.staffOrgId}:${provisionerId}`, [...PROVISIONER_ROLES]);
      const first = await runSeed(deps);
      expect(api.iamMembers.get(provisionerId)).toEqual(['IAM_ORG_MANAGER']);
      expect(first.changes).toContain(`made ${PROVISIONER_USER} IAM_ORG_MANAGER on the instance`);
      const second = await runSeed(deps);
      expect(second.changes).toEqual([]);
    });

    it('never grants IAM_OWNER', async () => {
      const { api, deps } = setup();
      await runSeed(deps);
      for (const roles of api.iamMembers.values()) expect(roles).not.toContain('IAM_OWNER');
    });

    it('warns instead of re-adding an instance member that lacks IAM_ORG_MANAGER', async () => {
      const { api, deps } = setup();
      const provisionerId = api.preexisting(api.staffOrgId, PROVISIONER_USER);
      api.members.set(`${api.staffOrgId}:${provisionerId}`, [...PROVISIONER_ROLES]);
      api.iamMembers.set(provisionerId, ['IAM_USER_MANAGER']);
      const result = await runSeed(deps);
      expect(api.iamMembers.get(provisionerId)).toEqual(['IAM_USER_MANAGER']);
      expect(result.warnings).toEqual([
        expect.stringMatching(/instance member without IAM_ORG_MANAGER.*Instance > Members/),
      ]);
    });
  });

  describe('P1 step 6: Actions v2', () => {
    it('creates the target once, keeps its signing key, and sets the execution every run', async () => {
      const { api, files, deps, logs } = setup();
      await runSeed(deps);
      expect(api.targets).toHaveLength(1);
      expect(api.targets[0]).toMatchObject({
        name: WEBHOOK_TARGET_NAME,
        endpoint: DEFAULT_WEBHOOK_URL,
      });
      const targetId = api.targets[0]?.id ?? '';
      const env = files.data.get('zitadel-api.env') ?? '';
      expect(env).toContain(`ZITADEL_ACTIONS_SIGNING_KEY=signing-${targetId}\n`);
      expect(files.data.get('zitadel.env')).not.toContain('ZITADEL_ACTIONS_SIGNING_KEY');
      expect(logs).toContain('Actions execution condition accepted: {"event":{"group":"user"}}');

      const second = await runSeed(deps);
      expect(second.changes).toEqual([]);
      expect(second.warnings).toEqual([]);
      expect(api.targets).toHaveLength(1);
      expect(files.data.get('zitadel-api.env')).toBe(env);
      expect(api.calls.filter((c) => c === `setUserEventExecution:${targetId}`)).toHaveLength(2);
    });

    it('warns loudly when the target exists but the signing key is lost', async () => {
      const { api, files, deps } = setup();
      await runSeed(deps);
      files.data.delete('zitadel-api.env');
      const result = await runSeed(deps);
      expect(api.targets).toHaveLength(1);
      expect(result.warnings).toEqual([
        expect.stringMatching(/no ZITADEL_ACTIONS_SIGNING_KEY.*Delete the target/),
      ]);
      expect(files.data.get('zitadel-api.env')).not.toContain('ZITADEL_ACTIONS_SIGNING_KEY');
    });

    it('moves both secrets out of a legacy zitadel.env without issuing anything new', async () => {
      const { api, files, deps } = setup();
      await runSeed(deps);
      const apiEnv = files.data.get('zitadel-api.env') ?? '';
      const patsBefore = api.patsIssued;
      const targetsBefore = api.targets.length;
      // A stack seeded before the split: one file with ids and secrets, no zitadel-api.env.
      files.data.delete('zitadel-api.env');
      files.data.set('zitadel.env', `${files.data.get('zitadel.env') ?? ''}${apiEnv}`);
      const result = await runSeed(deps);
      expect(result.warnings).toEqual([]);
      expect(api.patsIssued).toBe(patsBefore);
      expect(api.targets).toHaveLength(targetsBefore);
      expect(files.data.get('zitadel-api.env')).toBe(apiEnv);
      expect(files.data.get('zitadel.env')).not.toMatch(/TOKEN|SIGNING_KEY/);
    });

    it('warns when ZITADEL_WEBHOOK_URL differs from the stored target endpoint', async () => {
      const { api, deps } = setup();
      await runSeed(deps);
      const result = await runSeed({ ...deps, webhookUrl: 'http://api:3001/v1/hooks/zitadel' });
      expect(api.targets).toHaveLength(1);
      expect(result.warnings).toEqual([
        expect.stringMatching(/points at http:\/\/host\.docker\.internal.*http:\/\/api:3001/),
      ]);
    });
  });

  it('P1 step 8: seeds kernel rows once per run for the staff org; the second run changes none', async () => {
    const { api, store, deps } = setup();
    const first = await runSeed(deps);
    expect(store.kernelCalls).toEqual([api.staffOrgId]);
    expect(first.changes).toContain('seeded 5 kernel row(s) (grants, workflow, INR peg)');
    const second = await runSeed(deps);
    expect(store.kernelCalls).toEqual([api.staffOrgId, api.staffOrgId]);
    expect(second.changes).toEqual([]);
  });

  it('SEED-2: passes every staff persona to the kernel seed with its ZITADEL user id, login name and display name', async () => {
    const { api, store, deps } = setup();
    await runSeed(deps);
    const passed = store.kernelPersonas[0];
    const staff = PERSONAS.filter((p) => p.orgKind === 'staff');
    expect(passed?.map((p) => p.personaKey)).toEqual(staff.map((p) => p.key));
    for (const p of staff) {
      expect(passed?.find((x) => x.personaKey === p.key)).toEqual({
        personaKey: p.key,
        zitadelUserId: api.userIdOf(personaUsername(p.key)),
        email: personaUsername(p.key),
        displayName: `${p.givenName} ${p.familyName}`,
      });
    }
  });

  describe('P1 step 9: retire the bootstrap human admin', () => {
    it('makes the founder ORG_OWNER, deactivates the admin once, then reports already retired', async () => {
      const { api, deps, logs } = setup();
      const first = await runSeed(deps);
      const adminId = api.userIdOf(DEFAULT_ADMIN_USERNAME);
      const founderId = api.userIdOf(personaUsername('founder'));
      expect(api.members.get(`${api.staffOrgId}:${founderId}`)).toEqual([FOUNDER_ORG_ROLE]);
      expect([...api.deactivated]).toEqual([adminId]);
      expect(first.changes.some((c) => c.startsWith('retired bootstrap admin'))).toBe(true);

      const second = await runSeed(deps);
      expect(second.changes).toEqual([]);
      expect(logs).toContain(`bootstrap admin ${DEFAULT_ADMIN_USERNAME}: already retired`);
      expect(api.deactivated.has(api.userIdOf(BOOTSTRAP_SA_USER))).toBe(false);
    });

    it('never deactivates the seed service account, even when named as the admin', async () => {
      const { api, deps } = setup();
      const result = await runSeed({ ...deps, adminUsername: BOOTSTRAP_SA_USER });
      expect(api.deactivated.size).toBe(0);
      expect(result.warnings).toEqual([expect.stringMatching(/NOT retired: refusing/)]);
    });

    it('skips when the founder is a member without ORG_OWNER', async () => {
      const { api, deps } = setup();
      await runSeed({ ...deps, adminUsername: 'nobody@techrida.localhost' });
      const founderId = api.userIdOf(personaUsername('founder'));
      api.members.set(`${api.staffOrgId}:${founderId}`, ['ORG_USER_MANAGER']);
      const result = await runSeed(deps);
      expect(api.deactivated.size).toBe(0);
      expect(result.warnings).toEqual([expect.stringMatching(/NOT retired: .*without ORG_OWNER/)]);
    });

    it('skips without a founder persona or without founder TOTP', async () => {
      const api = new FakeZitadel();
      const adminId = api.preexisting(api.staffOrgId, DEFAULT_ADMIN_USERNAME);
      const founderId = api.preexisting(api.staffOrgId, personaUsername('founder'));
      const warnings: string[] = [];
      const deps = {
        api,
        changed: (): void => undefined,
        warn: (w: string): void => {
          warnings.push(w);
        },
        log: (): void => undefined,
      };
      const input = { staffOrgId: api.staffOrgId, adminUsername: DEFAULT_ADMIN_USERNAME };
      await retireBootstrapAdmin(deps, { ...input, founder: undefined });
      await retireBootstrapAdmin(deps, {
        ...input,
        founder: { userId: founderId, orgId: api.staffOrgId, hasTotp: false },
      });
      expect(warnings).toEqual([
        expect.stringMatching(/NOT retired: the founder persona does not exist/),
        expect.stringMatching(/NOT retired: the founder persona has no TOTP yet/),
      ]);
      expect(api.deactivated.has(adminId)).toBe(false);
      expect(api.mutations).toBe(0);
    });
  });
});
