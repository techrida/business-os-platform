// Idempotent ZITADEL provisioning for local development (`pnpm seed`).
//
// Rule of the whole file: look an object up by name first, create it only when it is missing,
// and record every mutation in `changes`. A run that records nothing prints "no changes".
//
// Never print passwords, client secrets, TOTP secrets, the PAT or a token. Only ids, names and
// claim KEYS.
//
// P1 (U6b) adds, in this order: the accountant role and persona, TOTP for every persona, the
// forceMfa login policy (only once every persona has TOTP, so a half-run never locks anyone out),
// a 15 min access-token lifetime (NFR security: a revoked role stops working within 15 min) and
// the `bos-loadtest-approver` machine user (k6 cannot approve its own requests: SoD, risk R13).
// U6b part 2 adds: a PAT for `bos-provisioner` (the API's ZITADEL admin client), the Actions v2
// webhook target and its user-event execution (user sync, ADR 0019), the kernel rows in the DB
// (role grants, `test_memo` workflow v1, INR peg) and, last, retiring the first-instance human admin
// once the Founder can log in with MFA (NFR security: no shared break-glass password left behind).
import { readFile, rm } from 'node:fs/promises';
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
import { seedKernelRows, setSeedActor, type DevPersona } from './db-seed.js';
import {
  APP_NAME,
  EXTRA_VENDORS,
  ORG_NAMES,
  PERSONAS,
  PROJECT_NAME,
  PROJECT_ROLES,
  generatePassword,
  passwordsFromFile,
  personaOrgKey,
  personaUsername,
  renderPersonasFile,
  totpSecretsFromFile,
  type ExtraVendorKey,
  type PersonaEntry,
  type RoleKey,
} from './personas.js';
import { totpCode } from './totp.js';
import {
  FORCE_MFA_POLICY,
  PORTAL_LOGIN_POLICY,
  ZitadelClient,
  createFetchTransport,
  type AppInfo,
  type MachineSpec,
  type ZitadelApi,
  type ZitadelInstanceApi,
  type ZitadelP1Api,
} from './zitadel-client.js';

export const SEED_TOOL = '@bos/seed-zitadel' as const;

export const LOADTEST_USER = 'bos-loadtest';
export const PROVISIONER_USER = 'bos-provisioner';
/**
 * Org roles of `bos-provisioner` on the staff org. ORG_USER_MANAGER creates and invites users.
 * Whether it may also write user grants is unverified (plan section 3, risk R7); ZITADEL answers
 * 403 if not, so ORG_USER_PERMISSION_EDITOR is granted up front instead of after a failure.
 * Never IAM_OWNER: a leaked API token must not own the instance.
 */
export const PROVISIONER_ROLES = ['ORG_USER_MANAGER', 'ORG_USER_PERMISSION_EDITOR'] as const;
/**
 * Instance (IAM) role of `bos-provisioner`, for K8 portal access. Granting a customer portal access makes the
 * API create a ZITADEL org for the customer, create and invite a user in it, grant it the BOS project and pin
 * the org's login policy (no self-registration, forced MFA). Org roles on the staff org cannot do the first
 * one (creating an org is an instance permission) nor reach users or policies in other orgs.
 *
 * IAM_ORG_MANAGER is the narrowest built-in role found that covers all four: in ZITADEL's default
 * InternalAuthZ role mapping it carries org.create plus org-wide user, user-grant, policy and project-grant
 * write permissions on every org. IAM_OWNER would also cover them but owns the instance (IAM members,
 * instance settings, IDPs), so it stays excluded. IAM_USER_MANAGER manages users but cannot create orgs.
 *
 * Tradeoff: an instance role reaches every org, the staff org included, so a leaked provisioner PAT can now
 * manage all orgs' users and policies. Keep the PAT in the API's secret store only.
 *
 * UNVERIFIED (no live probe, no docs fetched): the role name and its permission set are from ZITADEL's
 * defaults.yaml as remembered, not read in this repo. If CreateProjectGrant still answers 403, the
 * fallback is ORG_PROJECT_PERMISSION_EDITOR on the staff org (the BOS project's owner), not PROJECT_OWNER.
 */
export const PROVISIONER_IAM_ROLES = ['IAM_ORG_MANAGER'] as const;
/** A fresh provisioner PAT lives one year; a re-run reuses it while ZITADEL still lists it. */
export const PROVISIONER_PAT_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;
/** The Actions v2 target that pushes user events to the API (`POST /v1/hooks/zitadel`). */
export const WEBHOOK_TARGET_NAME = 'bos-users-webhook';
/** Dev default: the API runs on the host, ZITADEL in Docker. The app profile uses `http://api:3001/...`. */
export const DEFAULT_WEBHOOK_URL = 'http://host.docker.internal:3001/v1/hooks/zitadel';
/** `ZITADEL_FIRSTINSTANCE_ORG_HUMAN_USERNAME` comes from `ZITADEL_ADMIN_USERNAME` in `.env`. */
export const DEFAULT_ADMIN_USERNAME = 'admin@techrida.localhost';
/** The first-instance machine user whose PAT this seed runs with. It is never deactivated. */
export const BOOTSTRAP_SA_USER = 'bos-bootstrap-sa';
/** The Founder must own the staff org before the human admin goes, or nobody can administer it. */
export const FOUNDER_ORG_ROLE = 'ORG_OWNER';
export const SMTP_DESCRIPTION = 'bos-dev-mailpit';
/** k6's second machine user: approves step 1 as an accountant, so the requester is never the approver. */
export const LOADTEST_APPROVER_USER = 'bos-loadtest-approver';
/** How `ListAuthenticationMethodTypes` names a registered authenticator app. */
export const TOTP_METHOD = 'AUTHENTICATION_METHOD_TYPE_TOTP';
/** NFR security: a role revoked in ZITADEL reaches the API within one token lifetime. */
export const ACCESS_TOKEN_LIFETIME = '900s';
/**
 * The customer portal's own OIDC app (apps/portal), in the same project as the workspace app. Created only
 * when the seed is given PORTAL_PUBLIC_URL; its client id goes to `.dev/zitadel-portal.env`, which compose's
 * `portal` service reads after `zitadel.env` so it overrides the workspace's OIDC_CLIENT_ID.
 */
export const PORTAL_APP_NAME = 'Business OS portal';
export const PORTAL_ENV_FILE = 'zitadel-portal.env';
/**
 * The seed output that holds secrets (provisioner token, Actions signing key). compose lists it for `api` and
 * `worker` only; `zitadel.env`, which the web apps read too, keeps ids and never a TOKEN or KEY entry.
 */
export const API_ENV_FILE = 'zitadel-api.env';
export const API_SECRET_KEYS = [
  'ZITADEL_PROVISIONER_TOKEN',
  'ZITADEL_ACTIONS_SIGNING_KEY',
] as const;

/** Everything the seed calls on ZITADEL: the P0 surface plus the P1 and K8 additions. */
export type SeedApi = ZitadelApi & ZitadelP1Api & ZitadelInstanceApi;

/** A legal entity (`app.organizations`, ADR 0027 section 2). The seed upserts it on (tenant, code). */
export interface EntitySeed {
  code: string;
  name: string;
  legalName: string;
}

/** A customer or vendor company (`app.parties`); its kind is the kind of the IdP org behind it. */
export interface PartySeed {
  code: string;
  name: string;
}

/** A ZITADEL org (`app.idp_orgs`). The staff org has no party; a customer or vendor org has one. */
export type IdpOrgSeed =
  | { zitadelOrgId: string; kind: 'staff'; name: string; party: null }
  | { zitadelOrgId: string; kind: 'customer' | 'vendor'; name: string; party: PartySeed };

export interface TenancySeed {
  entity: EntitySeed;
  idpOrgs: IdpOrgSeed[];
}

/** ADR 0027 section 11: one default entity. The legal name is still to confirm with Kuu. */
export const SEED_ENTITY: EntitySeed = {
  code: 'TR',
  name: 'Techrida',
  legalName: 'Techrida Pvt. Ltd.',
};
/**
 * The dev parties. `customer` and `vendor` stand behind the customer and vendor ZITADEL orgs (tenancySeed upserts
 * them); the two foreign ones have no org, so the kernel's dev step creates them (DEV_FOREIGN_CUSTOMER and
 * DEV_FOREIGN_VENDOR in db-seed.ts; a test pins the codes together).
 */
export const SEED_PARTIES = {
  customer: { code: 'CUST-DEV', name: ORG_NAMES.customer },
  vendor: { code: 'VEND-DEV', name: ORG_NAMES.vendor },
  /** A US customer with no PAN (FX9). */
  foreignCustomer: { code: 'CUST-US-DEV', name: 'Acme Robotics Inc' },
  /** An Indian vendor with an address and a loose tax id (FX9). */
  foreignVendor: { code: 'VEND-IN-DEV', name: 'Mumbai Industrial Supplies Pvt Ltd' },
} as const satisfies Record<'customer' | 'vendor' | 'foreignCustomer' | 'foreignVendor', PartySeed>;
export const STAFF_IDP_ORG_NAME = 'Techrida Staff';

/** The dev stack's tenancy for the three ZITADEL orgs the seed created. */
export function tenancySeed(
  orgIds: Record<OrgKind, string>,
  extraVendorOrgIds: Partial<Record<ExtraVendorKey, string>> = {},
): TenancySeed {
  return {
    entity: SEED_ENTITY,
    idpOrgs: [
      { zitadelOrgId: orgIds.staff, kind: 'staff', name: STAFF_IDP_ORG_NAME, party: null },
      {
        zitadelOrgId: orgIds.customer,
        kind: 'customer',
        name: ORG_NAMES.customer,
        party: SEED_PARTIES.customer,
      },
      {
        zitadelOrgId: orgIds.vendor,
        kind: 'vendor',
        name: ORG_NAMES.vendor,
        party: SEED_PARTIES.vendor,
      },
      // Skipped when the org is unknown, so a caller that has no extra vendors gets the three orgs as before.
      ...EXTRA_VENDORS.flatMap((v): IdpOrgSeed[] => {
        const zitadelOrgId = extraVendorOrgIds[v.key];
        return zitadelOrgId
          ? [
              {
                zitadelOrgId,
                kind: 'vendor',
                name: v.orgName,
                party: { code: v.partyCode, name: v.orgName },
              },
            ]
          : [];
      }),
    ],
  };
}

export interface TenancyStore {
  /** Upserts the entity, the parties and the idp_orgs; returns how many rows (and tenants) changed. */
  upsertTenancy(seed: TenancySeed, correlationId: string): Promise<number>;
  /**
   * P1 step 8: role grants, the `test_memo` workflow and the INR peg for the tenant of the staff
   * org, found by its ZITADEL org id, and that tenant's default entity. Returns 0 on a second run.
   * With the staff personas it also seeds the dev departments and the VEND-DEV vendor (P4 SEED-2).
   */
  seedKernel(
    staffZitadelOrgId: string,
    correlationId: string,
    personas?: readonly DevPersona[],
  ): Promise<number>;
}

export interface SeedDeps {
  api: SeedApi;
  files: DevFiles;
  store: TenancyStore;
  log: (line: string) => void;
  issuer: string;
  workspaceUrl: string;
  /**
   * Public origin of the customer portal (PORTAL_PUBLIC_URL), without a trailing slash. Unset: no portal
   * app and no `.dev/zitadel-portal.env`, exactly as before the portal app existed.
   */
  portalUrl?: string;
  /** Clock for TOTP codes and the PAT expiry; tests pin it. Defaults to the real time. */
  now?: () => Date;
  /** Where ZITADEL posts user events. Defaults to DEFAULT_WEBHOOK_URL. */
  webhookUrl?: string;
  /** Login name of the first-instance human admin to retire. Defaults to DEFAULT_ADMIN_USERNAME. */
  adminUsername?: string;
  configureDevMailpit?: boolean;
  perfStaff?: boolean;
  perfPlatform?: boolean;
}

export interface SeedResult {
  /** The staff org's ZITADEL id; `--finalize` needs it to find the bootstrap service account. */
  staffOrgId: string;
  changes: string[];
  /** Problems the seed could not fix by itself; each line names the manual step. Not a change. */
  warnings: string[];
  token: TokenReport;
}

/** What later steps need to know about a persona after the persona and TOTP steps ran. */
export interface PersonaState {
  userId: string;
  orgId: string;
  /** ZITADEL has a verified TOTP for this user (whether or not we still know the secret). */
  hasTotp: boolean;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x) => b.includes(x));

export async function runSeed(deps: SeedDeps): Promise<SeedResult> {
  const { api, files, store, log } = deps;
  const now = deps.now ?? (() => new Date());
  // One id for every DB write of this run, so the audit log groups them.
  const correlationId = randomUUID();
  const changes: string[] = [];
  const warnings: string[] = [];
  const changed = (what: string): void => {
    changes.push(what);
    log(`  + ${what}`);
  };
  const warn = (what: string): void => {
    warnings.push(what);
    log(`  ! ${what}`);
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
  // Two more vendors for dev and QA, each in an org of its own (see EXTRA_VENDORS).
  const extraVendorOrgIds: Partial<Record<ExtraVendorKey, string>> = {};
  for (const vendor of EXTRA_VENDORS) {
    let id = await api.findOrgByName(vendor.orgName);
    if (!id) {
      id = await api.createOrg(vendor.orgName);
      changed(`created organization "${vendor.orgName}"`);
    }
    extraVendorOrgIds[vendor.key] = id;
  }
  const orgIdOf = (key: string): string =>
    (key in extraVendorOrgIds
      ? extraVendorOrgIds[key as ExtraVendorKey]
      : orgIds[key as OrgKind]) ?? '';

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

  // --- The customer portal's OIDC app: a public PKCE client like the workspace one (createOidcApp), so
  // apps/portal/src/lib/oidc.ts can sign in with client.None(). Same project, so OIDC_AUDIENCE, the role
  // claims and the customer persona's authorization and project grant apply unchanged. ---
  let portalApp: AppInfo | undefined;
  if (!deps.portalUrl) {
    // Without a portal URL nothing is created or changed, but an app a previous run created stays in
    // OIDC_ALLOWED_AZP: dropping it would make the API refuse every portal token while the portal keeps signing in.
    portalApp = (await api.findOidcApp(projectId, PORTAL_APP_NAME)) ?? undefined;
  } else {
    const redirectUri = `${deps.portalUrl}/auth/callback`;
    const postLogoutUri = `${deps.portalUrl}/`;
    portalApp = await api.findOidcApp(projectId, PORTAL_APP_NAME);
    if (!portalApp) {
      portalApp = await api.createOidcApp(projectId, {
        name: PORTAL_APP_NAME,
        redirectUris: [redirectUri],
        postLogoutRedirectUris: [postLogoutUri],
      });
      changed(`created OIDC app "${PORTAL_APP_NAME}"`);
    } else if (portalApp.accessTokenType !== 'OIDC_TOKEN_TYPE_JWT') {
      throw new Error(
        `OIDC app "${PORTAL_APP_NAME}" exists with access token type ${portalApp.accessTokenType}, expected JWT. ` +
          'Switch it in the console (Token Settings), or delete the app there and run `pnpm seed` again (it recreates it).',
      );
    } else if (
      !portalApp.redirectUris.includes(redirectUri) ||
      !portalApp.postLogoutRedirectUris.includes(postLogoutUri)
    ) {
      // Another stack's portal origin (a different PORTAL_HOST) stays allowed: add, never replace.
      const redirectUris = portalApp.redirectUris.includes(redirectUri)
        ? portalApp.redirectUris
        : [...portalApp.redirectUris, redirectUri];
      const postLogoutRedirectUris = portalApp.postLogoutRedirectUris.includes(postLogoutUri)
        ? portalApp.postLogoutRedirectUris
        : [...portalApp.postLogoutRedirectUris, postLogoutUri];
      await api.setOidcAppRedirects(projectId, portalApp.id, {
        redirectUris,
        postLogoutRedirectUris,
      });
      changed(`added ${deps.portalUrl} to the redirect URIs of OIDC app "${PORTAL_APP_NAME}"`);
    }
  }

  // --- Project grants: customer and vendor orgs may only use their own role. ---
  const grants = await api.listProjectGrants(projectId);
  const grantTargets: { orgId: string; name: string; role: RoleKey }[] = [
    { orgId: orgIds.customer, name: ORG_NAMES.customer, role: 'customer_user' },
    { orgId: orgIds.vendor, name: ORG_NAMES.vendor, role: 'vendor_user' },
    ...EXTRA_VENDORS.map((v) => ({
      orgId: orgIdOf(v.key),
      name: v.orgName,
      role: 'vendor_user' as const,
    })),
  ];
  for (const { orgId, name, role } of grantTargets) {
    const existing = grants.find((g) => g.grantedOrgId === orgId);
    if (!existing) {
      await api.createProjectGrant(projectId, orgId, [role]);
      changed(`granted project to ${name} with role ${role}`);
    } else if (!sameSet(existing.roleKeys, [role])) {
      await api.updateProjectGrant(projectId, orgId, [role]);
      changed(`updated project grant of ${name} to role ${role}`);
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

  // --- Personas (P1 step 1 adds the Accountant). Passwords and TOTP secrets persist in
  // .dev/personas.json across runs. ---
  const personasText = await files.read('personas.json');
  const passwords = passwordsFromFile(personasText);
  const storedTotp = totpSecretsFromFile(personasText);
  const entries: PersonaEntry[] = [];
  const personaState = new Map<string, PersonaState>();
  for (const persona of PERSONAS) {
    const orgId = orgIdOf(personaOrgKey(persona));
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
    const totpSecret = storedTotp.get(persona.key);
    entries.push({
      key: persona.key,
      label: `${persona.givenName} ${persona.familyName}`,
      orgKind: persona.orgKind,
      role: persona.role,
      username,
      preferredLoginName: user.preferredLoginName || username,
      password,
      // Last key, and only when known: the file must render byte for byte the same on a re-run.
      ...(totpSecret === undefined ? {} : { totpSecret }),
    });
    personaState.set(persona.key, { userId: user.id, orgId, hasTotp: false });
  }
  if (await files.write('personas.json', renderPersonasFile(entries))) {
    changed('wrote .dev/personas.json');
  }

  // --- P1 steps 2-3: TOTP for every persona, then forceMfa. ---
  // Allowing OTP as a second factor first can lock nobody out, and registration may need it.
  if (await api.addSecondFactor('SECOND_FACTOR_TYPE_OTP')) {
    changed('allowed TOTP as a second factor in the login policy');
  }
  await ensurePersonaTotp({ api, files, changed, warn, now }, entries, personaState);
  // forceMfa only when every persona has an authenticator: otherwise the next login of the one
  // without TOTP would demand a factor it cannot produce.
  const withoutTotp = [...personaState].filter(([, s]) => !s.hasTotp).map(([key]) => key);
  if (withoutTotp.length > 0) {
    warn(`forceMfa NOT enabled: personas without TOTP: ${withoutTotp.join(', ')}`);
    warn('portal login policy NOT pinned on the customer org: personas without TOTP');
  } else {
    if (await api.updateLoginPolicy(FORCE_MFA_POLICY)) {
      changed('login policy: forceMfa on, MFA setup not skippable');
    }
    // The customer org gets its own pinned portal policy (no registration, MFA forced), so an instance
    // change cannot open it. Same gate as forceMfa: it forces MFA on the customer persona, who must
    // already have TOTP.
    if (await api.ensureOrgLoginPolicy(orgIds.customer, PORTAL_LOGIN_POLICY)) {
      changed('pinned the portal login policy on the customer org');
    }
  }

  // --- P1 step 4: 15 min access tokens. ---
  if (await api.updateOidcSettings({ accessTokenLifetime: ACCESS_TOKEN_LIFETIME })) {
    changed(`set OIDC access-token lifetime to ${ACCESS_TOKEN_LIFETIME}`);
  }

  // --- Machine users for k6 (P1 step 7 adds the approver). Both live in k6.env, the only file the
  // k6 container loads (compose `env_file`). A secret is shown by ZITADEL once: never rotate it
  // needlessly. ---
  const k6Env = parseEnv(await files.read('k6.env'));
  const perfClients: Record<string, string> = {};
  const perfClientIds: string[] = [];
  const ensureMachineClient = async (
    spec: Omit<MachineSpec, 'orgId'>,
    role: RoleKey,
    storedSecret: string | undefined,
  ): Promise<string> => {
    let user = await api.findUser(staffOrgId, spec.username);
    if (!user) {
      user = await api.createMachineUser({ ...spec, orgId: staffOrgId });
      changed(`created machine user ${spec.username}`);
    }
    await ensureAuthorization(user.id, staffOrgId, [role], spec.username);
    if (storedSecret && user.hasSecret) return storedSecret;
    const secret = await api.addSecret(user.id);
    changed(`generated client secret for ${spec.username}`);
    return secret;
  };
  const loadSecret = await ensureMachineClient(
    {
      username: LOADTEST_USER,
      name: 'Business OS load test',
      description: 'k6 client-credentials user for perf gates (dev only)',
    },
    'sales',
    k6Env['K6_CLIENT_SECRET'],
  );
  const approverSecret = await ensureMachineClient(
    {
      username: LOADTEST_APPROVER_USER,
      name: 'Business OS load test approver',
      description: 'k6 accountant that approves step 1 of load-test requests (dev only)',
    },
    'accountant',
    k6Env['K6_APPROVER_CLIENT_SECRET'],
  );
  if (deps.perfStaff) {
    const name = 'Business OS disposable perf staff';
    const roles = [
      'sales',
      'accountant',
      'finance',
      'founder',
      'procurement',
      'management',
    ] as const;
    const orgId = (await api.findOrgByName(name)) ?? (await api.createOrg(name));
    const grant = grants.find((g) => g.grantedOrgId === orgId);
    if (!grant) await api.createProjectGrant(projectId, orgId, [...roles]);
    else if (!sameSet(grant.roleKeys, roles))
      await api.updateProjectGrant(projectId, orgId, [...roles]);
    const subjects: Record<string, string> = {};
    const portalOrgs: Record<string, string> = {};
    const portalRoles = deps.perfPlatform ? (['customer_user', 'vendor_user'] as const) : [];
    for (const role of [...roles, ...portalRoles]) {
      let accountOrg = orgId;
      if (role === 'customer_user' || role === 'vendor_user') {
        const portalName = 'Business OS disposable perf ' + role;
        accountOrg = (await api.findOrgByName(portalName)) ?? (await api.createOrg(portalName));
        if (!grants.some((g) => g.grantedOrgId === accountOrg))
          await api.createProjectGrant(projectId, accountOrg, [role]);
        portalOrgs[role] = accountOrg;
      }
      const username = `bos-perf-${role}`;
      const user =
        (await api.findUser(accountOrg, username)) ??
        (await api.createMachineUser({
          username,
          name: `Perf ${role}`,
          description: 'Disposable perf workload',
          orgId: accountOrg,
        }));
      await ensureAuthorization(
        user.id,
        accountOrg,
        role === 'management' ? [role, 'accountant'] : [role],
        username,
      );
      subjects[role] = user.id;
      const prefix = `K6_PERF_${role.toUpperCase()}`;
      perfClients[`${prefix}_CLIENT_ID`] = username;
      perfClients[`${prefix}_CLIENT_SECRET`] =
        (user.hasSecret && k6Env[`${prefix}_CLIENT_SECRET`]) || (await api.addSecret(user.id));
      perfClientIds.push(username);
    }
    await files.write(
      'perf-subjects.json',
      JSON.stringify({ orgId, subjects, ...(deps.perfPlatform ? { portalOrgs } : {}) }),
    );
  }
  if (
    await files.write(
      'k6.env',
      renderEnv({
        ...perfClients,
        K6_CLIENT_ID: LOADTEST_USER,
        K6_CLIENT_SECRET: loadSecret,
        K6_PROJECT_ID: projectId,
        K6_APPROVER_CLIENT_ID: LOADTEST_APPROVER_USER,
        K6_APPROVER_CLIENT_SECRET: approverSecret,
      }),
    )
  ) {
    changed('wrote .dev/k6.env');
  }

  // --- Machine user for staff invites (P1) and portal access (K8): ORG_USER_MANAGER +
  // ORG_USER_PERMISSION_EDITOR on staff, IAM_ORG_MANAGER on the instance, never IAM_OWNER. ---
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
  if (memberRoles === undefined) {
    await api.addOrgMember(staffOrgId, provisioner.id, [...PROVISIONER_ROLES]);
    changed(`made ${PROVISIONER_USER} ${PROVISIONER_ROLES.join(' + ')} on the staff org`);
  } else {
    // The client can only ADD a member; adding an existing one fails, so a P0 stack whose
    // provisioner has only ORG_USER_MANAGER needs one console click.
    const missing = PROVISIONER_ROLES.filter((r) => !memberRoles.includes(r));
    if (missing.length > 0) {
      warn(
        `${PROVISIONER_USER} is a staff org member without ${missing.join(', ')}. Add the role in ` +
          'the ZITADEL console (Organization > Members), or remove the member and run `pnpm seed` again.',
      );
    }
  }
  // K8 portal access: the instance role that lets the API create customer orgs (see PROVISIONER_IAM_ROLES).
  const iamRoles = await api.listIamMemberRoles(provisioner.id);
  if (iamRoles === undefined) {
    await api.addIamMember(provisioner.id, [...PROVISIONER_IAM_ROLES]);
    changed(`made ${PROVISIONER_USER} ${PROVISIONER_IAM_ROLES.join(' + ')} on the instance`);
  } else {
    // Same as the org member above: the client only adds, so an existing member is fixed by hand.
    const missing = PROVISIONER_IAM_ROLES.filter((r) => !iamRoles.includes(r));
    if (missing.length > 0) {
      warn(
        `${PROVISIONER_USER} is an instance member without ${missing.join(', ')}. Add the role in the ` +
          'ZITADEL console (Instance > Members), or remove the member and run `pnpm seed` again.',
      );
    }
  }

  // --- P1 step 5: the provisioner PAT, the API's credential for invites and user sync. ZITADEL
  // shows a PAT once, so reuse the stored one while the user still has a PAT (after
  // `stack:nuke` the new provisioner has none, and the stored token is dead). ---
  // Stacks seeded before the split still hold both secrets in zitadel.env: read them from there when the new
  // file has none, so the first run after the split moves them instead of losing them (ZITADEL shows each once).
  const legacyZitadelEnv = parseEnv(await files.read('zitadel.env'));
  const oldZitadelEnv = { ...legacyZitadelEnv, ...parseEnv(await files.read(API_ENV_FILE)) };
  let provisionerToken = oldZitadelEnv['ZITADEL_PROVISIONER_TOKEN'];
  const provisionerPats = await api.listPats(provisioner.id, staffOrgId);
  if (!provisionerToken || provisionerPats.length === 0) {
    const expiry = new Date(now().getTime() + PROVISIONER_PAT_LIFETIME_MS).toISOString();
    provisionerToken = (await api.addPat(provisioner.id, expiry, staffOrgId)).token;
    changed(`issued a PAT for ${PROVISIONER_USER} (expires ${expiry.slice(0, 10)})`);
  }

  // --- P1 step 6: Actions v2 pushes user events to the API (ADR 0019; reconcile covers misses). ---
  const webhookUrl = deps.webhookUrl ?? DEFAULT_WEBHOOK_URL;
  let signingKey = oldZitadelEnv['ZITADEL_ACTIONS_SIGNING_KEY'];
  // Not fatal: the 10-minute reconcile keeps app.users correct without the webhook (ADR 0019). The
  // usual cause is ZITADEL's HTTPClient.DenyList, which blocks private IPs such as the Docker network.
  try {
    let target = (await api.listTargets()).find((t) => t.name === WEBHOOK_TARGET_NAME);
    if (!target) {
      const created = await api.createTarget({
        name: WEBHOOK_TARGET_NAME,
        endpoint: webhookUrl,
        timeout: '10s',
        restAsync: {},
      });
      target = { id: created.id, name: WEBHOOK_TARGET_NAME, endpoint: webhookUrl };
      signingKey = created.signingKey;
      changed(`created Actions target ${WEBHOOK_TARGET_NAME} -> ${webhookUrl}`);
    } else {
      if (!signingKey) {
        // ZITADEL returns the key only on create or update, and the client has no update call.
        warn(
          `Actions target ${WEBHOOK_TARGET_NAME} exists but .dev/${API_ENV_FILE} has no ` +
            'ZITADEL_ACTIONS_SIGNING_KEY, so the API rejects every webhook. Delete the target in the ' +
            'ZITADEL console (Actions > Targets), then run `pnpm seed` again.',
        );
      }
      if (target.endpoint !== webhookUrl) {
        warn(
          `Actions target ${WEBHOOK_TARGET_NAME} points at ${target.endpoint}, but ZITADEL_WEBHOOK_URL ` +
            `is ${webhookUrl}. Delete the target in the ZITADEL console and run \`pnpm seed\` again.`,
        );
      }
    }
    // An idempotent PUT, sent on every run so a half-run that created the target still gets its
    // execution. Not a "change": nothing tells us whether it differed. Logs the shape, never the key.
    const condition = await api.setUserEventExecution(target.id);
    log(`Actions execution condition accepted: ${JSON.stringify(condition)}`);
  } catch (error) {
    warn(
      `Actions webhook not set up (${error instanceof Error ? error.message : String(error)}). ` +
        'User changes reach app.users through the 10-minute reconcile instead. If the message says ' +
        'DeniedURL, the endpoint resolves to an address in ZITADEL_HTTPCLIENT_DENYLIST.',
    );
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

  // --- Env file for the API and the workspace. Steps add keys to this record; one write at the end.
  // The API accepts a token only when its client (azp, else client_id) is listed here. k6 sends
  // K6_CLIENT_ID, the machine user's username, as the client-credentials client id, so that is
  // the client its tokens carry. R7 below checks it against a real token.
  // P1's approvals gate also signs in as the approver machine user, under its own client id.
  // The portal forwards its users' access tokens to the API, and they carry the portal's client id.
  const allowedAzp = [
    app.clientId,
    ...(portalApp ? [portalApp.clientId] : []),
    LOADTEST_USER,
    LOADTEST_APPROVER_USER,
    ...perfClientIds,
  ];
  const zitadelEnv: Record<string, string> = {
    OIDC_ISSUER: deps.issuer,
    OIDC_AUDIENCE: projectId,
    OIDC_CLIENT_ID: app.clientId,
    OIDC_ALLOWED_AZP: allowedAzp.join(','),
    ZITADEL_STAFF_ORG_ID: orgIds.staff,
    ZITADEL_CUSTOMER_ORG_ID: orgIds.customer,
    ZITADEL_VENDOR_ORG_ID: orgIds.vendor,
  };
  // The secrets go to their own file, read by api and worker only (compose.yaml). Only when known: a lost
  // key stays absent, so the file renders the same on every run. Written BEFORE zitadel.env: on a stack that
  // still has the secrets in zitadel.env, a failure between the two writes must not leave them in neither.
  const apiEnv: Record<string, string> = { ZITADEL_PROVISIONER_TOKEN: provisionerToken };
  if (signingKey) apiEnv['ZITADEL_ACTIONS_SIGNING_KEY'] = signingKey;
  if (await files.write(API_ENV_FILE, renderEnv(apiEnv))) {
    changed(`wrote .dev/${API_ENV_FILE}`);
  }
  if (await files.write('zitadel.env', renderEnv(zitadelEnv))) {
    changed('wrote .dev/zitadel.env');
  }
  // Only the portal's own client id: issuer, audience and the org ids come from zitadel.env, which the
  // portal reads first. Without PORTAL_PUBLIC_URL an existing file is left alone.
  if (
    portalApp &&
    (await files.write(PORTAL_ENV_FILE, renderEnv({ OIDC_CLIENT_ID: portalApp.clientId })))
  ) {
    changed(`wrote .dev/${PORTAL_ENV_FILE}`);
  }

  // --- Our own tenancy tables (ADR 0027): the TR entity, the parties, ZITADEL org id -> idp_orgs. ---
  const dbChanges = await store.upsertTenancy(
    tenancySeed(orgIds, extraVendorOrgIds),
    correlationId,
  );
  if (dbChanges > 0) changed(`upserted ${dbChanges} tenancy row(s) (entity, parties, idp_orgs)`);

  // --- P1 step 8: kernel rows (deny-by-default needs grants to exist; test_memo workflow v1). ---
  // The staff personas go along so the DB seed can create the dev departments and VEND-DEV, which need user ids.
  const devPersonas: DevPersona[] = [];
  for (const persona of PERSONAS) {
    const state = personaState.get(persona.key);
    if (persona.orgKind !== 'staff' || !state) continue;
    devPersonas.push({
      personaKey: persona.key,
      zitadelUserId: state.userId,
      email: personaUsername(persona.key),
      displayName: `${persona.givenName} ${persona.familyName}`,
    });
  }
  const kernelChanges = await store.seedKernel(orgIds.staff, correlationId, devPersonas);
  log(`kernel rows changed: ${kernelChanges}`);
  if (kernelChanges > 0) {
    changed(`seeded ${kernelChanges} kernel row(s) (grants, workflow, INR peg)`);
  }

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

  // --- P1 step 9, last: retire the first-instance human admin once the Founder replaces it. ---
  await retireBootstrapAdmin(
    { api, changed, warn, log },
    {
      staffOrgId,
      founder: personaState.get('founder'),
      adminUsername: deps.adminUsername ?? DEFAULT_ADMIN_USERNAME,
    },
  );

  return { staffOrgId, changes, warnings, token };
}

export interface FinalizeDeps {
  api: Pick<SeedApi, 'findUser' | 'deactivateUser'>;
  staffOrgId: string;
  /** Path of the bootstrap service account's token file (`ZITADEL_ADMIN_PAT_FILE`). */
  patFile: string;
  /** Deletes the token file; a file that is already gone is not an error. */
  removeFile: (path: string) => Promise<void>;
  log: (line: string) => void;
}

/**
 * Production only (`--finalize`): the bootstrap service account `bos-bootstrap-sa` is IAM_OWNER and its token
 * file sits in a volume. After the seed has done everything, deactivate the account and delete the file. Dev and
 * testrun never run this: their volumes survive a redeploy and the next seed needs the token again.
 * Order: deactivate first, then delete. If the deactivate call fails the file is kept, so the run can be repeated.
 */
export async function finalizeBootstrap(deps: FinalizeDeps): Promise<string[]> {
  const { api, staffOrgId, patFile, removeFile, log } = deps;
  const done: string[] = [];
  const account = await api.findUser(staffOrgId, BOOTSTRAP_SA_USER);
  if (!account) {
    // The lookup does not filter by state, so "not found" means the account is not where we looked. Deleting the
    // token file now could leave a live IAM_OWNER token in ZITADEL with no file to show for it.
    throw new Error(
      `finalize refused: ${BOOTSTRAP_SA_USER} was not found in the staff org, so its token file is kept.`,
    );
  }
  if (await api.deactivateUser(account.id)) {
    done.push(`deactivated ${BOOTSTRAP_SA_USER}`);
  } else {
    log(`finalize: ${BOOTSTRAP_SA_USER} was already deactivated`);
  }
  await removeFile(patFile);
  done.push(`deleted ${patFile}`);
  return done;
}

export interface RetireDeps {
  api: SeedApi;
  changed: (what: string) => void;
  warn: (what: string) => void;
  log: (line: string) => void;
}

/**
 * Deactivates the human admin from `ZITADEL_FIRSTINSTANCE_ORG_HUMAN_*`. Its password sits in
 * `.env`, so it is a shared credential without MFA. Runs only when the Founder can take over:
 * the persona exists, has TOTP and owns the staff org. Deactivate, not delete: a human can
 * reactivate it in the console. `bos-bootstrap-sa` (this seed's own identity) is never touched.
 */
export async function retireBootstrapAdmin(
  { api, changed, warn, log }: RetireDeps,
  input: { staffOrgId: string; founder: PersonaState | undefined; adminUsername: string },
): Promise<void> {
  const { staffOrgId, founder, adminUsername } = input;
  const skip = (why: string): void => warn(`bootstrap admin ${adminUsername} NOT retired: ${why}`);
  if (!founder) return skip('the founder persona does not exist');
  if (!founder.hasTotp) return skip('the founder persona has no TOTP yet');

  const founderRoles = await api.listOrgMemberRoles(founder.orgId, founder.userId);
  if (founderRoles === undefined) {
    await api.addOrgMember(founder.orgId, founder.userId, [FOUNDER_ORG_ROLE]);
    changed(`made persona founder ${FOUNDER_ORG_ROLE} on the staff org`);
  } else if (!founderRoles.includes(FOUNDER_ORG_ROLE)) {
    // The client cannot change an existing member's roles (see the provisioner step).
    return skip(
      `the founder is a staff org member without ${FOUNDER_ORG_ROLE}. Add it in the ZITADEL ` +
        'console (Organization > Members), then run `pnpm seed` again.',
    );
  }

  if (adminUsername === BOOTSTRAP_SA_USER) {
    return skip(`refusing: ${BOOTSTRAP_SA_USER} is the seed's own service account`);
  }
  const admin = await api.findUser(staffOrgId, adminUsername);
  if (!admin) {
    return skip(
      'no such user in the staff org. Set ZITADEL_ADMIN_USERNAME to the first admin login name.',
    );
  }
  const serviceAccount = await api.findUser(staffOrgId, BOOTSTRAP_SA_USER);
  if (admin.id === serviceAccount?.id || admin.id === founder.userId) {
    return skip('it resolves to the seed service account or the founder; refusing');
  }
  if (await api.deactivateUser(admin.id)) {
    changed(`retired bootstrap admin ${adminUsername} (deactivated; the founder is ORG_OWNER)`);
  } else {
    log(`bootstrap admin ${adminUsername}: already retired`);
  }
}

interface TotpStepDeps {
  api: SeedApi;
  files: DevFiles;
  changed: (what: string) => void;
  warn: (what: string) => void;
  now: () => Date;
}

/**
 * P1 step 2. Per persona: skip when ZITADEL has TOTP and we know the secret; warn when ZITADEL has
 * TOTP but the secret is gone (the client has no "remove TOTP" call, so a human must remove it);
 * otherwise register, verify with one code, and save the secret at once.
 *
 * Why save after every persona: a verified TOTP whose secret was never written cannot be recovered
 * (ZITADEL never shows it again), so the gap between verify and write stays one persona wide.
 */
async function ensurePersonaTotp(
  { api, files, changed, warn, now }: TotpStepDeps,
  entries: PersonaEntry[],
  personaState: Map<string, PersonaState>,
): Promise<void> {
  for (const entry of entries) {
    const state = personaState.get(entry.key);
    if (!state) continue;
    const methods = await api.listAuthMethods(state.userId);
    if (methods.includes(TOTP_METHOD)) {
      state.hasTotp = true;
      if (entry.totpSecret === undefined) {
        warn(
          `persona ${entry.key} has TOTP in ZITADEL but .dev/personas.json has no secret, so ` +
            'nobody can log in as it. Remove its authenticator in the ZITADEL console ' +
            `(Users > ${entry.username} > Authenticators), then run \`pnpm seed\` again.`,
        );
      }
      continue;
    }
    const registration = await api.registerTotp(state.userId);
    await api.verifyTotpRegistration(state.userId, totpCode(registration.secret, now()));
    entry.totpSecret = registration.secret;
    state.hasTotp = true;
    await files.write('personas.json', renderPersonasFile(entries));
    changed(`registered TOTP for persona ${entry.key} (secret saved to .dev/personas.json)`);
  }
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
// Postgres side: the tenancy tables and kernel rows through the owner role (DATABASE_MIGRATE_URL).

/** An open connection plus how to close it; injectable so tests can check the SQL order. */
export interface PgConnection {
  client: pg.ClientBase;
  close: () => Promise<void>;
}
export type PgConnect = () => Promise<PgConnection>;

export class PgTenancyStore implements TenancyStore {
  constructor(private readonly connect: PgConnect) {}

  /** The real store: a fresh `pg.Client` per call on `DATABASE_MIGRATE_URL` (the table owner). */
  static fromUrl(connectionString: string): PgTenancyStore {
    return new PgTenancyStore(async () => {
      const client = new pg.Client({ connectionString });
      await client.connect();
      return { client, close: () => client.end() };
    });
  }

  async upsertTenancy(seed: TenancySeed, correlationId: string): Promise<number> {
    const { client, close } = await this.connect();
    let changed = 0;
    try {
      await client.query('BEGIN');
      // One tenant for the whole dev stack: the staff IdP org's, else the one an entity already
      // references, else any, else a new one (inserted below, after the seed actor is set).
      const staffOrg = seed.idpOrgs.find((org) => org.kind === 'staff');
      let tenantId: string | undefined;
      if (staffOrg) {
        const fromIdp = await client.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM app.idp_orgs WHERE zitadel_org_id = $1',
          [staffOrg.zitadelOrgId],
        );
        tenantId = fromIdp.rows[0]?.tenant_id;
      }
      if (!tenantId) {
        const fromOrgs = await client.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM app.organizations LIMIT 1',
        );
        tenantId = fromOrgs.rows[0]?.tenant_id;
      }
      if (!tenantId) {
        const tenants = await client.query<{ id: string }>('SELECT id FROM app.tenants LIMIT 1');
        tenantId = tenants.rows[0]?.id;
      }
      const newTenant = !tenantId;
      tenantId ??= randomUUID();
      const entity = await client.query<{ id: string }>(
        'SELECT id FROM app.organizations WHERE tenant_id = $1 AND code = $2',
        [tenantId, seed.entity.code],
      );
      const entityId = entity.rows[0]?.id ?? randomUUID();

      // R5: the audit trigger RAISEs on any app.* write without an actor. parties and idp_orgs have
      // no organization_id, so their events take bos.organization_id: the entity written below.
      await setSeedActor(client, { tenantId, organizationId: entityId, correlationId });
      if (newTenant) {
        await client.query('INSERT INTO app.tenants (id) VALUES ($1)', [tenantId]);
        changed += 1;
      }
      // WHERE ... IS DISTINCT FROM makes an unchanged row a no-op, so rowCount is 0 on a re-run.
      // is_default is set on insert only: the DO UPDATE never moves the tenant's default.
      const upsertedEntity = await client.query(
        `INSERT INTO app.organizations (id, tenant_id, organization_id, code, name, legal_name, is_default)
         VALUES ($1, $2, $1, $3, $4, $5, true)
         ON CONFLICT (tenant_id, code) DO UPDATE
           SET name = EXCLUDED.name, legal_name = EXCLUDED.legal_name
           WHERE (app.organizations.name, app.organizations.legal_name)
                 IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.legal_name)`,
        [entityId, tenantId, seed.entity.code, seed.entity.name, seed.entity.legalName],
      );
      changed += upsertedEntity.rowCount ?? 0;

      for (const org of seed.idpOrgs) {
        let partyId: string | null = null;
        if (org.kind !== 'staff') {
          const result = await this.upsertParty(client, tenantId, org);
          partyId = result.partyId;
          changed += result.changed;
        }
        const upserted = await client.query(
          `INSERT INTO app.idp_orgs (tenant_id, zitadel_org_id, kind, party_id, name)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (zitadel_org_id) DO UPDATE
             SET kind = EXCLUDED.kind, party_id = EXCLUDED.party_id, name = EXCLUDED.name
             WHERE (app.idp_orgs.kind, app.idp_orgs.party_id, app.idp_orgs.name)
                   IS DISTINCT FROM (EXCLUDED.kind, EXCLUDED.party_id, EXCLUDED.name)`,
          [tenantId, org.zitadelOrgId, org.kind, partyId, org.name],
        );
        changed += upserted.rowCount ?? 0;
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      await close();
    }
    return changed;
  }

  /**
   * The party behind a customer or vendor IdP org. A party already linked to the org (0013 migrated
   * it with a code derived from its name) is re-coded in place, so it is never duplicated. Ids are
   * re-selected, never read from RETURNING: a guarded DO UPDATE that changes nothing returns no row.
   */
  private async upsertParty(
    client: pg.ClientBase,
    tenantId: string,
    org: Extract<IdpOrgSeed, { party: PartySeed }>,
  ): Promise<{ partyId: string; changed: number }> {
    const linked = await client.query<{ party_id: string | null }>(
      'SELECT party_id FROM app.idp_orgs WHERE zitadel_org_id = $1',
      [org.zitadelOrgId],
    );
    const linkedId = linked.rows[0]?.party_id;
    if (linkedId) {
      // kind stays: the idp_orgs FK includes it, and the org's kind never changes here.
      const recoded = await client.query(
        `UPDATE app.parties SET code = $2, name = $3, updated_at = now()
         WHERE id = $1 AND (code, name) IS DISTINCT FROM ($2::text, $3::text)`,
        [linkedId, org.party.code, org.party.name],
      );
      return { partyId: linkedId, changed: recoded.rowCount ?? 0 };
    }
    const inserted = await client.query(
      `INSERT INTO app.parties (tenant_id, kind, code, name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, code) DO UPDATE
         SET name = EXCLUDED.name, updated_at = now()
         WHERE app.parties.name IS DISTINCT FROM EXCLUDED.name`,
      [tenantId, org.kind, org.party.code, org.party.name],
    );
    const found = await client.query<{ id: string }>(
      'SELECT id FROM app.parties WHERE tenant_id = $1 AND code = $2',
      [tenantId, org.party.code],
    );
    const partyId = found.rows[0]?.id;
    if (!partyId) throw new Error(`party ${org.party.code} not found after upsert`);
    return { partyId, changed: inserted.rowCount ?? 0 };
  }

  async seedKernel(
    staffZitadelOrgId: string,
    correlationId: string,
    personas?: readonly DevPersona[],
  ): Promise<number> {
    const { client, close } = await this.connect();
    try {
      // The staff IdP org names the tenant; the kernel rows go to that tenant's default entity.
      const org = await client.query<{ id: string; tenant_id: string }>(
        `SELECT o.id, o.tenant_id FROM app.idp_orgs i
         JOIN app.organizations o ON o.tenant_id = i.tenant_id AND o.is_default
         WHERE i.zitadel_org_id = $1`,
        [staffZitadelOrgId],
      );
      const staff = org.rows[0];
      if (!staff) {
        throw new Error(
          `no default entity for staff IdP org ${staffZitadelOrgId}: app.idp_orgs or app.organizations has no row`,
        );
      }
      // seedKernelRows opens its own transaction and sets the seed actor inside it.
      return await seedKernelRows(
        client,
        { tenantId: staff.tenant_id, organizationId: staff.id, correlationId },
        personas,
      );
    } finally {
      await close();
    }
  }
}

// ---------------------------------------------------------------------------------------------

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name}`);
  return value;
}

/**
 * The seed creates users with known passwords, a machine user with a client secret, and deactivates the
 * first-instance admin. Pointed at a real instance by a copied `.env`, that is a security incident, so it
 * refuses anything that is not `localhost` or `*.localhost` unless `SEED_ALLOW_NON_LOCAL=1` says the operator
 * meant it. The host is parsed, not substring-matched: `localhost.evil.com` and `localhost@evil.com` are not local.
 */
export function assertDevTarget(issuer: string, env: NodeJS.ProcessEnv): void {
  if (env['SEED_ALLOW_NON_LOCAL'] === '1') return;
  let host: string | undefined;
  try {
    host = new URL(issuer).hostname.toLowerCase();
  } catch {
    // Not a URL: treated as non-local below, the safe side.
  }
  if (host === 'localhost' || host?.endsWith('.localhost')) return;
  throw new Error(
    `The dev seed refuses to run against ${host ?? 'an unparseable URL'}: it is not localhost or *.localhost. ` +
      'This seed creates personas with known passwords and machine-user secrets, which must never reach a real ' +
      'ZITADEL instance. If this really is a throwaway non-local dev instance, set SEED_ALLOW_NON_LOCAL=1.',
  );
}

export async function main(): Promise<void> {
  const issuer = (process.env['OIDC_ISSUER'] ?? 'https://auth.localhost').replace(/\/+$/, '');
  // ZITADEL picks the instance from the Host header, so we call it by its public name via Caddy.
  const apiBase = (process.env['ZITADEL_API_URL'] ?? issuer).replace(/\/+$/, '');
  // First, before any file or network access: guard the URL the seed writes to, and the issuer it records.
  assertDevTarget(apiBase, process.env);
  assertDevTarget(issuer, process.env);
  const perfStaff = process.env['BOS_PERF_STAFF'] === '1';
  if (perfStaff) {
    assertDevTarget(apiBase, {});
    assertDevTarget(issuer, {});
    if (!['development', 'test'].includes(process.env['NODE_ENV'] ?? ''))
      throw new Error('Perf staff require a dev/test seed');
  }
  const finalize = process.argv.includes('--finalize');
  const patFile = process.env['ZITADEL_ADMIN_PAT_FILE'] ?? '/zitadel/admin/admin.pat';
  const personasFile = process.env['BOS_DEV_PERSONAS_FILE'] ?? '.dev/personas.json';
  const workspaceUrl = (process.env['WORKSPACE_PUBLIC_URL'] ?? 'https://app.localhost').replace(
    /\/+$/,
    '',
  );
  // No default: without PORTAL_PUBLIC_URL the seed creates no portal app (see PORTAL_APP_NAME).
  const portalUrl = process.env['PORTAL_PUBLIC_URL']?.replace(/\/+$/, '') || undefined;

  const pat = (await readFile(patFile, 'utf8')).trim();
  if (!pat) throw new Error(`Admin PAT file ${patFile} is empty`);

  const api = new ZitadelClient({ transport: createFetchTransport(apiBase, pat), baseUrl: issuer });
  const result = await runSeed({
    api,
    files: new DevDir(dirname(personasFile)),
    store: PgTenancyStore.fromUrl(requiredEnv('DATABASE_MIGRATE_URL')),
    log: (line) => console.log(line),
    issuer,
    workspaceUrl,
    ...(portalUrl ? { portalUrl } : {}),
    webhookUrl: process.env['ZITADEL_WEBHOOK_URL'] ?? DEFAULT_WEBHOOK_URL,
    adminUsername: process.env['ZITADEL_ADMIN_USERNAME'] ?? DEFAULT_ADMIN_USERNAME,
    perfStaff,
    perfPlatform: process.env['BOS_PERF_PLATFORM'] === '1',
    configureDevMailpit: process.env['BOS_SEED_DEV_MAILPIT'] === 'true',
  });
  console.log(
    result.changes.length === 0 ? 'no changes' : `done: ${result.changes.length} change(s)`,
  );
  if (result.warnings.length > 0) {
    // Repeated at the end on purpose: these are manual steps and must not scroll away.
    console.warn(`ATTENTION: ${result.warnings.length} manual step(s) needed:`);
    for (const line of result.warnings) console.warn(`  ! ${line}`);
  }
  if (finalize) {
    if (result.warnings.length > 0) {
      throw new Error(
        '--finalize refused: the manual steps above still need the bootstrap token. Do them, run the seed again, then finalize.',
      );
    }
    for (const line of await finalizeBootstrap({
      api,
      staffOrgId: result.staffOrgId,
      patFile,
      removeFile: (path) => rm(path, { force: true }),
      log: (line) => console.log(line),
    })) {
      console.log(`finalize: ${line}`);
    }
  }
}

// Only run when executed directly, so tests can import this module.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error: unknown) => {
    console.error(`seed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
