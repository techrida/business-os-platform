import { describe, expect, it, vi } from 'vitest';

import { runSeed, SEED_TOOL, type OrgRow, type SeedDeps, type TenancyStore } from './index.js';
import { type DevFiles, parseEnv } from './outputs.js';
import { PERSONAS, PROJECT_ROLES } from './personas.js';
import type {
  AppInfo,
  AuthorizationInfo,
  GrantInfo,
  HumanSpec,
  MachineSpec,
  OidcAppSpec,
  ProjectInfo,
  SmtpSpec,
  UserInfo,
  ZitadelApi,
} from './zitadel-client.js';

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * In-memory ZITADEL. Every method that changes state bumps `mutations`, so a test can assert that a
 * second run made no mutating call at all (stronger than checking the printed message).
 */
class FakeZitadel implements ZitadelApi {
  mutations = 0;
  secretsIssued = 0;
  passwordResets = 0;
  tokenClaims: Record<string, unknown> | undefined;
  appTokenType = 'OIDC_TOKEN_TYPE_JWT';
  private seq = 0;
  private readonly orgs = new Map<string, string>(); // name -> id
  private readonly projects = new Map<
    string,
    { id: string; owner: string; assertion: boolean; authRequired: boolean }
  >();
  private readonly roles = new Set<string>();
  private readonly grants = new Map<string, string[]>(); // org id -> roles
  private app: AppInfo | undefined;
  private readonly users = new Map<string, UserInfo & { orgId: string; username: string }>();
  private readonly auths = new Map<string, { id: string; roles: string[] }>(); // user id -> auth
  private readonly members = new Map<string, string[]>(); // `${org}:${user}` -> roles
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
  findOidcApp(): Promise<AppInfo | undefined> {
    return Promise.resolve(this.app && { ...this.app, accessTokenType: this.appTokenType });
  }
  createOidcApp(_p: string, _spec: OidcAppSpec): Promise<AppInfo> {
    this.mutate();
    this.app = { id: this.id('app'), clientId: 'client-1', accessTokenType: 'OIDC_TOKEN_TYPE_JWT' };
    return Promise.resolve(this.app);
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
  rows = new Map<string, OrgRow>();
  upsertOrganizations(rows: OrgRow[]): Promise<number> {
    let changed = 0;
    for (const row of rows) {
      const old = this.rows.get(row.zitadelOrgId);
      if (!old || old.kind !== row.kind || old.name !== row.name) changed += 1;
      this.rows.set(row.zitadelOrgId, row);
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
    configureDevMailpit: true,
  };
  return { api, files, store, deps, logs };
}

describe('@bos/seed-zitadel', () => {
  it('exports its tool name', () => {
    expect(SEED_TOOL).toBe('@bos/seed-zitadel');
  });

  it('first run creates everything and writes the dev files', async () => {
    const { api, files, store, deps } = setup();
    const result = await runSeed(deps);

    expect(result.changes.length).toBeGreaterThan(10);
    expect(await api.listProjectRoles()).toHaveLength(PROJECT_ROLES.length);
    expect([...files.data.keys()].sort()).toEqual(['k6.env', 'personas.json', 'zitadel.env']);
    expect(files.data.get('zitadel.env')).toContain('OIDC_CLIENT_ID=client-1');
    // The API's azp allow-list: the workspace app plus the k6 machine user, or perf:load gets 401.
    expect(parseEnv(files.data.get('zitadel.env'))['OIDC_ALLOWED_AZP']).toBe(
      'client-1,bos-loadtest',
    );
    expect(result.token.clientId).toBe('bos-loadtest');
    expect(files.data.get('k6.env')).toContain('K6_CLIENT_ID=bos-loadtest');
    expect(store.rows.size).toBe(3);
    const personas = JSON.parse(files.data.get('personas.json') ?? '[]') as unknown[];
    expect(personas).toHaveLength(PERSONAS.length);
    expect(api.secretsIssued).toBe(1);
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
    expect(api.mutations).toBe(mutationsAfterFirst);
    expect(api.secretsIssued).toBe(1); // the client secret must not rotate
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

  it('keeps persona passwords across runs and never logs secrets', async () => {
    const { files, deps, logs } = setup();
    await runSeed(deps);
    const before = files.data.get('personas.json') ?? '';
    await runSeed(deps);
    expect(files.data.get('personas.json')).toBe(before);

    const secrets = (JSON.parse(before) as { password: string }[]).map((p) => p.password);
    secrets.push(/K6_CLIENT_SECRET=(.*)/.exec(files.data.get('k6.env') ?? '')?.[1] ?? 'missing');
    for (const secret of secrets) {
      expect(secret.length).toBeGreaterThan(5);
      for (const line of logs) expect(line).not.toContain(secret);
    }
  });

  it('resets passwords (and only that) when personas.json is lost', async () => {
    const { api, files, deps } = setup();
    await runSeed(deps);
    const secretsBefore = api.secretsIssued;
    files.data.delete('personas.json');

    const result = await runSeed(deps);

    expect(api.passwordResets).toBe(PERSONAS.length);
    expect(api.secretsIssued).toBe(secretsBefore);
    expect(result.changes.some((c) => c.includes('personas.json'))).toBe(true);
  });

  it('issues a new client secret only when k6.env lost it', async () => {
    const { api, files, deps } = setup();
    await runSeed(deps);
    files.data.delete('k6.env');
    await runSeed(deps);
    expect(api.secretsIssued).toBe(2);
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
});
