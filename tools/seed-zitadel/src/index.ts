// Idempotent ZITADEL provisioning for local development (`pnpm seed`).
//
// Rule of the whole file: look an object up by name first, create it only when it is missing,
// and record every mutation in `changes`. A run that records nothing prints "no changes".
//
// Never print passwords, client secrets, the PAT or a token. Only ids, names and claim KEYS.
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';

import type { OrgKind } from '@bos/contracts';
import pg from 'pg';

import {
  DevDir,
  inspectToken,
  loadtestScope,
  parseEnv,
  renderEnv,
  type DevFiles,
  type TokenReport,
} from './outputs.js';
import {
  APP_NAME,
  ORG_NAMES,
  PERSONAS,
  PROJECT_NAME,
  PROJECT_ROLES,
  generatePassword,
  passwordsFromFile,
  personaUsername,
  renderPersonasFile,
  type PersonaEntry,
} from './personas.js';
import { ZitadelClient, createFetchTransport, type ZitadelApi } from './zitadel-client.js';

export const SEED_TOOL = '@bos/seed-zitadel' as const;

export const LOADTEST_USER = 'bos-loadtest';
export const PROVISIONER_USER = 'bos-provisioner';
export const PROVISIONER_ROLE = 'ORG_USER_MANAGER';
export const SMTP_DESCRIPTION = 'bos-dev-mailpit';

export interface OrgRow {
  zitadelOrgId: string;
  kind: OrgKind;
  name: string;
}

export interface TenancyStore {
  /** Returns how many rows (and tenants) were created or changed. */
  upsertOrganizations(rows: OrgRow[]): Promise<number>;
}

export interface SeedDeps {
  api: ZitadelApi;
  files: DevFiles;
  store: TenancyStore;
  log: (line: string) => void;
  issuer: string;
  workspaceUrl: string;
  configureDevMailpit?: boolean;
}

export interface SeedResult {
  changes: string[];
  token: TokenReport;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

export async function runSeed(deps: SeedDeps): Promise<SeedResult> {
  const { api, files, store, log } = deps;
  const changes: string[] = [];
  const changed = (what: string): void => {
    changes.push(what);
    log(`  + ${what}`);
  };

  // --- Organisations. Staff is the first-instance org; the other two are ours. ---
  const staffOrgId = await api.getDefaultOrgId();
  const orgIds: Record<OrgKind, string> = { staff: staffOrgId, customer: '', vendor: '' };
  for (const kind of ['customer', 'vendor'] as const) {
    const name = ORG_NAMES[kind];
    let id = await api.findOrgByName(name);
    if (!id) {
      id = await api.createOrg(name);
      changed(`created organization "${name}"`);
    }
    orgIds[kind] = id;
  }

  // --- Project, its roles, and "assert roles on authentication". ---
  const project = await api.findProject(staffOrgId, PROJECT_NAME);
  let projectId: string;
  if (!project) {
    projectId = await api.createProject(staffOrgId, PROJECT_NAME);
    changed(`created project "${PROJECT_NAME}"`);
  } else {
    projectId = project.id;
    if (!project.projectRoleAssertion) {
      await api.enableRoleAssertion(projectId);
      changed('enabled "assert roles on authentication"');
    }
    if (!project.authorizationRequired) {
      await api.enableAuthorizationRequired(projectId);
      changed('enabled "check for authorization on authentication"');
    }
  }

  // Unscoped sign-ins read the instance policy before they discover the user's organization.
  if (await api.ensureInstancePasswordReset()) {
    changed('configured the instance login policy for private password reset');
  }

  // Nobody may register themselves on the staff org: staff are invited.
  if (await api.ensureStaffLoginPolicy(staffOrgId)) {
    changed('configured staff login policy for invitations and private password reset');
  }

  const haveRoles = new Set(await api.listProjectRoles(projectId));
  for (const role of PROJECT_ROLES) {
    if (!haveRoles.has(role)) {
      await api.addProjectRole(projectId, role, role);
      changed(`added project role ${role}`);
    }
  }

  // --- The workspace OIDC app. ---
  let app = await api.findOidcApp(projectId, APP_NAME);
  if (!app) {
    app = await api.createOidcApp(projectId, {
      name: APP_NAME,
      redirectUris: [`${deps.workspaceUrl}/auth/callback`],
      postLogoutRedirectUris: [`${deps.workspaceUrl}/`],
    });
    changed(`created OIDC app "${APP_NAME}"`);
  } else if (app.accessTokenType !== 'OIDC_TOKEN_TYPE_JWT') {
    // We do not silently rewrite an app someone changed: the API needs JWTs, so say it loudly.
    throw new Error(
      `OIDC app "${APP_NAME}" exists with access token type ${app.accessTokenType}, expected JWT. ` +
        'Switch it in the console (Token Settings), or delete the app there and run `pnpm seed` again (it recreates it). ' +
        'Last resort only: `BOS_CONFIRM_NUKE=yes pnpm stack:nuke` deletes the whole stack, including the database AND its backups.',
    );
  }

  // --- Project grants: customer and vendor orgs may only use their own role. ---
  const grants = await api.listProjectGrants(projectId);
  for (const [kind, role] of [
    ['customer', 'customer_user'],
    ['vendor', 'vendor_user'],
  ] as const) {
    const orgId = orgIds[kind];
    const existing = grants.find((g) => g.grantedOrgId === orgId);
    if (!existing) {
      await api.createProjectGrant(projectId, orgId, [role]);
      changed(`granted project to ${ORG_NAMES[kind]} with role ${role}`);
    } else if (!sameSet(existing.roleKeys, [role])) {
      await api.updateProjectGrant(projectId, orgId, [role]);
      changed(`updated project grant of ${ORG_NAMES[kind]} to role ${role}`);
    }
  }

  const ensureAuthorization = async (
    userId: string,
    orgId: string,
    roleKeys: string[],
    label: string,
  ): Promise<void> => {
    const existing = await api.findAuthorization(userId, projectId);
    if (!existing) {
      await api.createAuthorization(userId, projectId, orgId, roleKeys);
      changed(`granted ${label} role ${roleKeys.join(',')}`);
    } else if (!sameSet(existing.roleKeys, roleKeys)) {
      await api.updateAuthorization(existing.id, roleKeys);
      changed(`set ${label} roles to ${roleKeys.join(',')}`);
    }
  };

  // --- Personas. Passwords persist in .dev/personas.json across runs. ---
  const passwords = passwordsFromFile(await files.read('personas.json'));
  const entries: PersonaEntry[] = [];
  for (const persona of PERSONAS) {
    const orgId = orgIds[persona.orgKind];
    const username = personaUsername(persona.key);
    let user = await api.findUser(orgId, username);
    let password = passwords.get(persona.key);
    if (!user) {
      password ??= generatePassword();
      user = await api.createHumanUser({
        orgId,
        username,
        email: username,
        givenName: persona.givenName,
        familyName: persona.familyName,
        password,
      });
      changed(`created persona ${persona.key}`);
    } else if (!password) {
      // The user exists but the password file is gone: set a fresh one so the file is usable.
      password = generatePassword();
      await api.setPassword(user.id, password);
      changed(`reset password of persona ${persona.key} (personas.json had none)`);
    }
    await ensureAuthorization(user.id, orgId, [persona.role], `persona ${persona.key}`);
    entries.push({
      key: persona.key,
      label: `${persona.givenName} ${persona.familyName}`,
      orgKind: persona.orgKind,
      role: persona.role,
      username,
      preferredLoginName: user.preferredLoginName || username,
      password,
    });
  }
  if (await files.write('personas.json', renderPersonasFile(entries))) {
    changed('wrote .dev/personas.json');
  }

  // --- Machine user for k6. The secret is shown by ZITADEL once, so never rotate it needlessly. ---
  const k6Env = parseEnv(await files.read('k6.env'));
  let loadUser = await api.findUser(staffOrgId, LOADTEST_USER);
  if (!loadUser) {
    loadUser = await api.createMachineUser({
      orgId: staffOrgId,
      username: LOADTEST_USER,
      name: 'Business OS load test',
      description: 'k6 client-credentials user for perf gates (dev only)',
    });
    changed(`created machine user ${LOADTEST_USER}`);
  }
  await ensureAuthorization(loadUser.id, staffOrgId, ['sales'], LOADTEST_USER);
  let loadSecret = k6Env['K6_CLIENT_SECRET'];
  if (!loadSecret || !loadUser.hasSecret) {
    loadSecret = await api.addSecret(loadUser.id);
    changed(`generated client secret for ${LOADTEST_USER}`);
  }
  if (
    await files.write(
      'k6.env',
      renderEnv({
        K6_CLIENT_ID: LOADTEST_USER,
        K6_CLIENT_SECRET: loadSecret,
        K6_PROJECT_ID: projectId,
      }),
    )
  ) {
    changed('wrote .dev/k6.env');
  }

  // --- Machine user for staff invites in P1: ORG_USER_MANAGER on staff only, never IAM_OWNER. ---
  let provisioner = await api.findUser(staffOrgId, PROVISIONER_USER);
  if (!provisioner) {
    provisioner = await api.createMachineUser({
      orgId: staffOrgId,
      username: PROVISIONER_USER,
      name: 'Business OS provisioner',
      description: 'Invites staff users (P1). Org user manager on the staff org.',
    });
    changed(`created machine user ${PROVISIONER_USER}`);
  }
  const memberRoles = await api.listOrgMemberRoles(staffOrgId, provisioner.id);
  if (!memberRoles?.includes(PROVISIONER_ROLE)) {
    await api.addOrgMember(staffOrgId, provisioner.id, [PROVISIONER_ROLE]);
    changed(`made ${PROVISIONER_USER} ${PROVISIONER_ROLE} on the staff org`);
  }

  // --- Activate local mail delivery for password reset and other ZITADEL notifications. ---
  if (
    deps.configureDevMailpit &&
    (await api.ensureSmtp({
      description: SMTP_DESCRIPTION,
      host: 'mailpit:1025',
      senderAddress: 'noreply@bos.test',
      senderName: 'Business OS (dev)',
    }))
  ) {
    changed('activated the Mailpit email provider');
  }

  // --- Env file for the API and the workspace. ---
  // The API accepts a token only when its client (azp, else client_id) is listed here. k6 sends
  // K6_CLIENT_ID, the machine user's username, as the client-credentials client id, so that is
  // the client its tokens carry. R7 below checks it against a real token.
  const allowedAzp = [app.clientId, LOADTEST_USER];
  if (
    await files.write(
      'zitadel.env',
      renderEnv({
        OIDC_ISSUER: deps.issuer,
        OIDC_AUDIENCE: projectId,
        OIDC_CLIENT_ID: app.clientId,
        OIDC_ALLOWED_AZP: allowedAzp.join(','),
        ZITADEL_STAFF_ORG_ID: orgIds.staff,
        ZITADEL_CUSTOMER_ORG_ID: orgIds.customer,
        ZITADEL_VENDOR_ORG_ID: orgIds.vendor,
      }),
    )
  ) {
    changed('wrote .dev/zitadel.env');
  }

  // --- Our own organizations table: ZITADEL org id -> tenant/org. ---
  const dbChanges = await store.upsertOrganizations([
    { zitadelOrgId: orgIds.staff, kind: 'staff', name: 'Techrida Staff' },
    { zitadelOrgId: orgIds.customer, kind: 'customer', name: ORG_NAMES.customer },
    { zitadelOrgId: orgIds.vendor, kind: 'vendor', name: ORG_NAMES.vendor },
  ]);
  if (dbChanges > 0) changed(`upserted ${dbChanges} app.organizations row(s)`);

  // --- R7: fetch a real token and show which claims ZITADEL puts in it. Never print the token. ---
  const token = await fetchTokenReport(api, loadSecret, projectId);
  log(`R7 token claim keys: ${token.claimKeys.join(', ')}`);
  log(`R7 token client (azp, else client_id): ${token.clientId ?? '(none)'}`);
  log(
    `R7 aud contains project id: ${String(token.audienceHasProject)}; ` +
      `role claim: ${String(token.hasRoleClaim)}; resourceowner claim: ${String(token.hasResourceOwnerClaim)}`,
  );
  const problems: string[] = [];
  if (!token.audienceHasProject) problems.push('aud does not contain the project id');
  if (!token.hasRoleClaim) problems.push('no urn:zitadel:iam:org:project:*:roles claim');
  if (!token.hasResourceOwnerClaim) problems.push('no urn:zitadel:iam:user:resourceowner:* claim');
  // A client id is not a secret, so the observed value goes into the message.
  if (token.clientId === undefined || !allowedAzp.includes(token.clientId)) {
    problems.push(
      `token client "${token.clientId ?? '(none)'}" is not in OIDC_ALLOWED_AZP (${allowedAzp.join(',')}); the API would answer 401`,
    );
  }
  if (problems.length > 0) {
    throw new Error(`R7 failed for the ${LOADTEST_USER} token: ${problems.join('; ')}`);
  }

  return { changes, token };
}

async function fetchTokenReport(
  api: ZitadelApi,
  secret: string,
  projectId: string,
): Promise<TokenReport> {
  // A secret or grant created a moment ago can take a second to be usable.
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const token = await api.clientCredentialsToken(
        LOADTEST_USER,
        secret,
        loadtestScope(projectId),
      );
      return inspectToken(token, projectId);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

// ---------------------------------------------------------------------------------------------
// Postgres side: `app.organizations` through the owner role (DATABASE_MIGRATE_URL).

export class PgTenancyStore implements TenancyStore {
  constructor(private readonly connectionString: string) {}

  async upsertOrganizations(rows: OrgRow[]): Promise<number> {
    const client = new pg.Client({ connectionString: this.connectionString });
    await client.connect();
    let changed = 0;
    try {
      await client.query('BEGIN');
      // One tenant for the whole dev stack: reuse the one already referenced, else any, else create.
      const fromOrgs = await client.query<{ tenant_id: string }>(
        'SELECT tenant_id FROM app.organizations LIMIT 1',
      );
      let tenantId = fromOrgs.rows[0]?.tenant_id;
      if (!tenantId) {
        const tenants = await client.query<{ id: string }>('SELECT id FROM app.tenants LIMIT 1');
        tenantId = tenants.rows[0]?.id;
      }
      if (!tenantId) {
        tenantId = randomUUID();
        await client.query('INSERT INTO app.tenants (id) VALUES ($1)', [tenantId]);
        changed += 1;
      }
      for (const row of rows) {
        const id = randomUUID();
        // WHERE ... IS DISTINCT FROM makes an unchanged row a no-op, so rowCount is 0 on a re-run.
        const result = await client.query(
          `INSERT INTO app.organizations (id, tenant_id, organization_id, kind, name, zitadel_org_id)
           VALUES ($1, $2, $1, $3, $4, $5)
           ON CONFLICT (zitadel_org_id) DO UPDATE
             SET kind = EXCLUDED.kind, name = EXCLUDED.name
             WHERE (app.organizations.kind, app.organizations.name)
                   IS DISTINCT FROM (EXCLUDED.kind, EXCLUDED.name)`,
          [id, tenantId, row.kind, row.name, row.zitadelOrgId],
        );
        changed += result.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await client.end();
    }
    return changed;
  }
}

// ---------------------------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

export async function main(): Promise<void> {
  const issuer = (process.env['OIDC_ISSUER'] ?? 'https://auth.localhost').replace(/\/+$/, '');
  const patFile = process.env['ZITADEL_ADMIN_PAT_FILE'] ?? '/zitadel/bootstrap/admin.pat';
  const personasFile = process.env['BOS_DEV_PERSONAS_FILE'] ?? '.dev/personas.json';
  const workspaceUrl = (process.env['WORKSPACE_PUBLIC_URL'] ?? 'https://app.localhost').replace(
    /\/+$/,
    '',
  );
  // ZITADEL picks the instance from the Host header, so we call it by its public name via Caddy.
  const apiBase = (process.env['ZITADEL_API_URL'] ?? issuer).replace(/\/+$/, '');

  const pat = (await readFile(patFile, 'utf8')).trim();
  if (!pat) throw new Error(`Admin PAT file ${patFile} is empty`);

  const api = new ZitadelClient({ transport: createFetchTransport(apiBase, pat), baseUrl: issuer });
  const result = await runSeed({
    api,
    files: new DevDir(dirname(personasFile)),
    store: new PgTenancyStore(requiredEnv('DATABASE_MIGRATE_URL')),
    log: (line) => console.log(line),
    issuer,
    workspaceUrl,
    configureDevMailpit: process.env['BOS_SEED_DEV_MAILPIT'] === 'true',
  });
  console.log(
    result.changes.length === 0 ? 'no changes' : `done: ${result.changes.length} change(s)`,
  );
}

// Only run when executed directly, so tests can import this module.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(`seed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
