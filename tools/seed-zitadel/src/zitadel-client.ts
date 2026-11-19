// Thin, typed ZITADEL client for the seed tool.
//
// Why a domain-level interface (`ZitadelApi`) and not just "call(path, body)": the seed's
// idempotency logic (index.ts) is unit-tested against an in-memory fake that implements this
// interface, so the real HTTP shapes live in exactly one place, this file.
//
// API choice (ZITADEL v4.20.1, proto files read at that tag):
//  - v2 resource APIs (Organization, Project, Application, Authorization, User) are listed as GA on
//    https://zitadel.com/docs/apis/introduction and are called over the Connect protocol with JSON:
//    `POST /zitadel.<pkg>.v2.<Service>/<Method>`, header `Connect-Protocol-Version: 1`,
//    lowerCamelCase fields, enum values as their proto names.
//    Example page: https://zitadel.com/docs/reference/api/project/zitadel.project.v2.ProjectService.CreateProject
//  - v1 is used only where v2 has no GA equivalent: org members and the org login policy
//    (management v1; v2 SettingsService has only GetLoginSettings, no setter) and the email
//    provider / SMTP settings (admin v1). The v2 InternalPermissionService (administrators) is not on
//    the GA list of that page, so ORG_USER_MANAGER goes through management v1 `AddOrgMember`.
//  - Proto sources: https://github.com/zitadel/zitadel/tree/v4.20.1/proto/zitadel
//
// If a path or field name turns out wrong on a live instance, this table and the bodies below are the
// only things to fix.
import { z } from 'zod';

export const ENDPOINTS = {
  listOrgs: '/zitadel.org.v2.OrganizationService/ListOrganizations',
  addOrg: '/zitadel.org.v2.OrganizationService/AddOrganization',

  listProjects: '/zitadel.project.v2.ProjectService/ListProjects',
  createProject: '/zitadel.project.v2.ProjectService/CreateProject',
  updateProject: '/zitadel.project.v2.ProjectService/UpdateProject',
  listProjectRoles: '/zitadel.project.v2.ProjectService/ListProjectRoles',
  addProjectRole: '/zitadel.project.v2.ProjectService/AddProjectRole',
  listProjectGrants: '/zitadel.project.v2.ProjectService/ListProjectGrants',
  createProjectGrant: '/zitadel.project.v2.ProjectService/CreateProjectGrant',
  updateProjectGrant: '/zitadel.project.v2.ProjectService/UpdateProjectGrant',

  listApps: '/zitadel.application.v2.ApplicationService/ListApplications',
  createApp: '/zitadel.application.v2.ApplicationService/CreateApplication',

  listUsers: '/zitadel.user.v2.UserService/ListUsers',
  createUser: '/zitadel.user.v2.UserService/CreateUser',
  setPassword: '/zitadel.user.v2.UserService/SetPassword',
  addSecret: '/zitadel.user.v2.UserService/AddSecret',

  listAuthorizations: '/zitadel.authorization.v2.AuthorizationService/ListAuthorizations',
  createAuthorization: '/zitadel.authorization.v2.AuthorizationService/CreateAuthorization',
  updateAuthorization: '/zitadel.authorization.v2.AuthorizationService/UpdateAuthorization',

  // management v1 (REST): the target org comes from the `x-zitadel-orgid` header.
  listOrgMembers: '/management/v1/orgs/me/members/_search',
  addOrgMember: '/management/v1/orgs/me/members',

  // management v1 login policy of the org in `x-zitadel-orgid`. Verified at tag v4.20.1
  // (proto/zitadel/management.proto): GET = GetLoginPolicy (effective policy; `isDefault` true means
  // inherited from the instance), POST = AddCustomLoginPolicy, PUT = UpdateCustomLoginPolicy.
  orgLoginPolicy: '/management/v1/policies/login',

  // admin v1 (REST): `AddSMTPConfig` is deprecated in favour of the email-provider endpoints.
  listEmailProviders: '/admin/v1/email/_search',
  addEmailProviderSmtp: '/admin/v1/email/smtp',
  activateEmailProvider: (id: string) => `/admin/v1/email/${encodeURIComponent(id)}/_activate`,

  // OIDC token endpoint (standard, not a ZITADEL API).
  token: '/oauth/v2/token',
} as const;

/** Thrown for any non-2xx answer. The message never contains the PAT or a request body. */
export class ZitadelError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    detail: string,
  ) {
    super(`ZITADEL ${path} answered ${status}: ${detail}`);
    this.name = 'ZitadelError';
  }
}

export interface Transport {
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<unknown>;
  /** REST only (management v1 has no Connect endpoints, so reads there are plain GETs). */
  get(path: string, headers?: Record<string, string>): Promise<unknown>;
  /** REST only. */
  put(path: string, body: unknown, headers?: Record<string, string>): Promise<unknown>;
}

const ErrorBodySchema = z.object({ code: z.string().optional(), message: z.string().optional() });

export function createFetchTransport(
  baseUrl: string,
  pat: string,
  fetchImpl: typeof fetch = fetch,
): Transport {
  const base = baseUrl.replace(/\/+$/, '');
  const send = async (
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<unknown> => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        authorization: `Bearer ${pat}`,
        ...headers,
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        const parsed = ErrorBodySchema.safeParse(JSON.parse(text));
        if (parsed.success)
          detail = `${parsed.data.code ?? ''} ${parsed.data.message ?? ''}`.trim();
      } catch {
        // Not JSON (for example a proxy error page): keep the truncated text.
      }
      throw new ZitadelError(path, res.status, detail);
    }
    return text.length > 0 ? (JSON.parse(text) as unknown) : {};
  };
  return {
    post: (path, body, headers = {}) => send('POST', path, body, headers),
    get: (path, headers = {}) => send('GET', path, undefined, headers),
    put: (path, body, headers = {}) => send('PUT', path, body, headers),
  };
}

// ---------------------------------------------------------------------------------------------
// Domain types used by the seed.

export interface ProjectInfo {
  id: string;
  projectRoleAssertion: boolean;
  /** "Check for authorization on authentication": a user without a project role cannot sign in. */
  authorizationRequired: boolean;
}
export interface AppInfo {
  id: string;
  clientId: string;
  accessTokenType: string;
}
export interface UserInfo {
  id: string;
  preferredLoginName: string;
  /** Machine users only. */
  hasSecret: boolean;
}
export interface GrantInfo {
  grantedOrgId: string;
  roleKeys: string[];
}
export interface AuthorizationInfo {
  id: string;
  roleKeys: string[];
}
export interface OidcAppSpec {
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
}
export interface HumanSpec {
  orgId: string;
  username: string;
  email: string;
  givenName: string;
  familyName: string;
  password: string;
}
export interface MachineSpec {
  orgId: string;
  username: string;
  name: string;
  description: string;
}
export interface SmtpSpec {
  description: string;
  host: string;
  senderAddress: string;
  senderName: string;
}

export interface ZitadelApi {
  /** The first-instance org ("staff"). */
  getDefaultOrgId(): Promise<string>;
  findOrgByName(name: string): Promise<string | undefined>;
  createOrg(name: string): Promise<string>;

  findProject(ownerOrgId: string, name: string): Promise<ProjectInfo | undefined>;
  createProject(ownerOrgId: string, name: string): Promise<string>;
  enableRoleAssertion(projectId: string): Promise<void>;
  enableAuthorizationRequired(projectId: string): Promise<void>;
  listProjectRoles(projectId: string): Promise<string[]>;
  addProjectRole(projectId: string, key: string, displayName: string): Promise<void>;
  listProjectGrants(projectId: string): Promise<GrantInfo[]>;
  createProjectGrant(projectId: string, orgId: string, roleKeys: string[]): Promise<void>;
  updateProjectGrant(projectId: string, orgId: string, roleKeys: string[]): Promise<void>;

  findOidcApp(projectId: string, name: string): Promise<AppInfo | undefined>;
  createOidcApp(projectId: string, spec: OidcAppSpec): Promise<AppInfo>;

  findUser(orgId: string, username: string): Promise<UserInfo | undefined>;
  createHumanUser(spec: HumanSpec): Promise<UserInfo>;
  createMachineUser(spec: MachineSpec): Promise<UserInfo>;
  setPassword(userId: string, password: string): Promise<void>;
  /** Generates a NEW client secret each call. Only call when none is known. */
  addSecret(userId: string): Promise<string>;

  findAuthorization(userId: string, projectId: string): Promise<AuthorizationInfo | undefined>;
  createAuthorization(
    userId: string,
    projectId: string,
    orgId: string,
    roleKeys: string[],
  ): Promise<void>;
  updateAuthorization(authorizationId: string, roleKeys: string[]): Promise<void>;

  listOrgMemberRoles(orgId: string, userId: string): Promise<string[] | undefined>;
  addOrgMember(orgId: string, userId: string, roles: string[]): Promise<void>;

  /**
   * Makes sure the org's login policy has `allowRegister` false (no self-registration). Creates a
   * custom org policy when the org inherits the instance default. Returns true when it changed
   * something, false when self-registration was already off (nothing is written then).
   */
  ensureStaffLoginPolicy(orgId: string): Promise<boolean>;

  /** Returns true when a provider was created (false: already present). */
  ensureSmtp(spec: SmtpSpec): Promise<boolean>;

  /** Client-credentials token, returned only to the caller; never log it. */
  clientCredentialsToken(clientId: string, clientSecret: string, scope: string): Promise<string>;
}

// ---------------------------------------------------------------------------------------------
// Response parsing. Protobuf JSON omits empty arrays and false booleans, so default them.

const Str = z.string();
const IdOnly = z.object({ id: Str.min(1) });
const OrgList = z.object({ result: z.array(z.object({ id: Str.min(1), name: Str })).default([]) });
const AddOrgResponse = z.object({ organizationId: Str.min(1) });
const ProjectList = z.object({
  projects: z
    .array(
      z.object({
        projectId: Str.min(1),
        organizationId: Str,
        name: Str,
        projectRoleAssertion: z.boolean().default(false),
        authorizationRequired: z.boolean().default(false),
      }),
    )
    .default([]),
});
const CreateProjectResponse = z.object({ projectId: Str.min(1) });
const RoleList = z.object({ projectRoles: z.array(z.object({ key: Str })).default([]) });
const GrantList = z.object({
  projectGrants: z
    .array(
      z.object({
        grantedOrganizationId: Str,
        grantedRoleKeys: z.array(Str).default([]),
      }),
    )
    .default([]),
});
const AppList = z.object({
  applications: z
    .array(
      z.object({
        applicationId: Str.min(1),
        name: Str,
        oidcConfiguration: z
          .object({ clientId: Str, accessTokenType: Str.default('OIDC_TOKEN_TYPE_BEARER') })
          .optional(),
      }),
    )
    .default([]),
});
const CreateAppResponse = z.object({
  applicationId: Str.min(1),
  oidcConfiguration: z.object({ clientId: Str.min(1) }),
});
const UserList = z.object({
  result: z
    .array(
      z.object({
        userId: Str.min(1),
        preferredLoginName: Str.default(''),
        machine: z.object({ hasSecret: z.boolean().default(false) }).optional(),
      }),
    )
    .default([]),
});
const AddSecretResponse = z.object({ clientSecret: Str.min(1) });
const AuthorizationList = z.object({
  authorizations: z
    .array(z.object({ id: Str.min(1), roles: z.array(z.object({ key: Str })).default([]) }))
    .default([]),
});
const MemberList = z.object({
  result: z.array(z.object({ userId: Str, roles: z.array(Str).default([]) })).default([]),
});
const ProviderList = z.object({
  result: z
    .array(z.object({ id: Str.min(1), description: Str.default(''), state: Str.optional() }))
    .default([]),
});
// Protobuf JSON: false booleans and empty lists are omitted. Everything else in `policy` is carried
// over verbatim when the policy is rewritten (see CARRY_OVER).
const LoginPolicyResponse = z.object({
  policy: z.looseObject({
    isDefault: z.boolean().default(false),
    allowRegister: z.boolean().default(false),
    hidePasswordReset: z.boolean().default(false),
    ignoreUnknownUsernames: z.boolean().default(false),
    secondFactors: z.array(Str).default([]),
    multiFactors: z.array(Str).default([]),
    idps: z.array(z.unknown()).default([]),
  }),
  isDefault: z.boolean().default(false),
});
// AddCustomLoginPolicy and UpdateCustomLoginPolicy are full replacements (proto3 scalars), so every
// setting must be sent back or it silently resets (allowUsernamePassword would become false and lock
// everyone out). These are all the scalar/duration fields both requests share.
const CARRY_OVER = [
  'allowUsernamePassword',
  'allowExternalIdp',
  'forceMfa',
  'passwordlessType',
  'defaultRedirectUri',
  'passwordCheckLifetime',
  'externalLoginCheckLifetime',
  'mfaInitSkipLifetime',
  'secondFactorCheckLifetime',
  'multiFactorCheckLifetime',
  'allowDomainDiscovery',
  'disableLoginWithEmail',
  'disableLoginWithPhone',
  'forceMfaLocalOnly',
] as const;
const TokenResponse = z.object({ access_token: Str.min(1) });

function parse<S extends z.ZodType>(schema: S, data: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Unexpected ZITADEL response for ${what}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

const EQ_QUERY = 'TEXT_QUERY_METHOD_EQUALS'; // user + org queries
const EQ_FILTER = 'TEXT_FILTER_METHOD_EQUALS'; // project + application + authorization filters

export interface ClientOptions {
  transport: Transport;
  /** Public base URL, used for the token endpoint (goes through Caddy like the browser does). */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** How long to wait for a freshly created user to show up in the list projection. */
  projectionWaitMs?: number;
}

export class ZitadelClient implements ZitadelApi {
  private readonly transport: Transport;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly projectionWaitMs: number;

  constructor(options: ClientOptions) {
    this.transport = options.transport;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.projectionWaitMs = options.projectionWaitMs ?? 10_000;
  }

  async getDefaultOrgId(): Promise<string> {
    const res = parse(
      OrgList,
      await this.transport.post(ENDPOINTS.listOrgs, { queries: [{ defaultQuery: {} }] }),
      'ListOrganizations(default)',
    );
    const org = res.result[0];
    if (!org) throw new Error('ZITADEL reports no default organization; is the instance set up?');
    return org.id;
  }

  async findOrgByName(name: string): Promise<string | undefined> {
    const res = parse(
      OrgList,
      await this.transport.post(ENDPOINTS.listOrgs, {
        queries: [{ nameQuery: { name, method: EQ_QUERY } }],
      }),
      'ListOrganizations(name)',
    );
    return res.result.find((o) => o.name === name)?.id;
  }

  async createOrg(name: string): Promise<string> {
    return parse(
      AddOrgResponse,
      await this.transport.post(ENDPOINTS.addOrg, { name }),
      'AddOrganization',
    ).organizationId;
  }

  async findProject(ownerOrgId: string, name: string): Promise<ProjectInfo | undefined> {
    const res = parse(
      ProjectList,
      await this.transport.post(ENDPOINTS.listProjects, {
        filters: [{ projectNameFilter: { projectName: name, method: EQ_FILTER } }],
      }),
      'ListProjects',
    );
    // The PAT is instance-wide, so match the owner org too: a granted copy is not "ours".
    const project = res.projects.find((p) => p.name === name && p.organizationId === ownerOrgId);
    return (
      project && {
        id: project.projectId,
        projectRoleAssertion: project.projectRoleAssertion,
        authorizationRequired: project.authorizationRequired,
      }
    );
  }

  async createProject(ownerOrgId: string, name: string): Promise<string> {
    return parse(
      CreateProjectResponse,
      await this.transport.post(ENDPOINTS.createProject, {
        organizationId: ownerOrgId,
        name,
        // "Assert roles on authentication": role claims are put into tokens.
        projectRoleAssertion: true,
        // CR-02: a user needs a role in this project to sign in. Whoever registers themselves (or is
        // created by hand) without an authorization gets no session for this app. Every seeded persona
        // and the load-test user gets a role in the seed, so they are unaffected.
        authorizationRequired: true,
        // Left off: the customer and vendor orgs are covered by project grants and every user by an
        // authorization above. Requiring an org grant as well would add a second gate that we cannot
        // exercise here (the owner org holds no grant of its own), for no extra protection.
        projectAccessRequired: false,
      }),
      'CreateProject',
    ).projectId;
  }

  async enableRoleAssertion(projectId: string): Promise<void> {
    await this.transport.post(ENDPOINTS.updateProject, { projectId, projectRoleAssertion: true });
  }

  async enableAuthorizationRequired(projectId: string): Promise<void> {
    // Only this flag is sent: UpdateProject leaves omitted optional fields unchanged.
    await this.transport.post(ENDPOINTS.updateProject, { projectId, authorizationRequired: true });
  }

  async listProjectRoles(projectId: string): Promise<string[]> {
    const res = parse(
      RoleList,
      await this.transport.post(ENDPOINTS.listProjectRoles, { projectId }),
      'ListProjectRoles',
    );
    return res.projectRoles.map((r) => r.key);
  }

  async addProjectRole(projectId: string, key: string, displayName: string): Promise<void> {
    await this.transport.post(ENDPOINTS.addProjectRole, { projectId, roleKey: key, displayName });
  }

  async listProjectGrants(projectId: string): Promise<GrantInfo[]> {
    const res = parse(
      GrantList,
      await this.transport.post(ENDPOINTS.listProjectGrants, {
        filters: [{ inProjectIdsFilter: { ids: [projectId] } }],
      }),
      'ListProjectGrants',
    );
    return res.projectGrants.map((g) => ({
      grantedOrgId: g.grantedOrganizationId,
      roleKeys: g.grantedRoleKeys,
    }));
  }

  async createProjectGrant(projectId: string, orgId: string, roleKeys: string[]): Promise<void> {
    await this.transport.post(ENDPOINTS.createProjectGrant, {
      projectId,
      grantedOrganizationId: orgId,
      roleKeys,
    });
  }

  async updateProjectGrant(projectId: string, orgId: string, roleKeys: string[]): Promise<void> {
    await this.transport.post(ENDPOINTS.updateProjectGrant, {
      projectId,
      grantedOrganizationId: orgId,
      roleKeys,
    });
  }

  async findOidcApp(projectId: string, name: string): Promise<AppInfo | undefined> {
    const res = parse(
      AppList,
      await this.transport.post(ENDPOINTS.listApps, {
        filters: [{ projectIdFilter: { projectId } }, { nameFilter: { name, method: EQ_FILTER } }],
      }),
      'ListApplications',
    );
    const app = res.applications.find((a) => a.name === name && a.oidcConfiguration);
    if (!app?.oidcConfiguration) return undefined;
    return {
      id: app.applicationId,
      clientId: app.oidcConfiguration.clientId,
      accessTokenType: app.oidcConfiguration.accessTokenType,
    };
  }

  async createOidcApp(projectId: string, spec: OidcAppSpec): Promise<AppInfo> {
    const res = parse(
      CreateAppResponse,
      await this.transport.post(ENDPOINTS.createApp, {
        projectId,
        name: spec.name,
        oidcConfiguration: {
          redirectUris: spec.redirectUris,
          postLogoutRedirectUris: spec.postLogoutRedirectUris,
          responseTypes: ['OIDC_RESPONSE_TYPE_CODE'],
          // Refresh tokens let the workspace keep a session without a new redirect every hour.
          grantTypes: ['OIDC_GRANT_TYPE_AUTHORIZATION_CODE', 'OIDC_GRANT_TYPE_REFRESH_TOKEN'],
          applicationType: 'OIDC_APP_TYPE_WEB',
          // NONE = public client without a secret; PKCE protects the code exchange.
          authMethodType: 'OIDC_AUTH_METHOD_TYPE_NONE',
          version: 'OIDC_VERSION_1_0',
          // Allows http/localhost-style redirect URIs. Harmless for https://app.localhost.
          developmentMode: true,
          // JWT, so the API can verify the access token offline with the JWKS.
          accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
          // Without these the role and resourceowner claims are only in userinfo, not in the token.
          accessTokenRoleAssertion: true,
          idTokenRoleAssertion: true,
          idTokenUserinfoAssertion: false,
        },
      }),
      'CreateApplication',
    );
    return {
      id: res.applicationId,
      clientId: res.oidcConfiguration.clientId,
      accessTokenType: 'OIDC_TOKEN_TYPE_JWT',
    };
  }

  async findUser(orgId: string, username: string): Promise<UserInfo | undefined> {
    const res = parse(
      UserList,
      await this.transport.post(ENDPOINTS.listUsers, {
        queries: [
          { userNameQuery: { userName: username, method: EQ_QUERY } },
          { organizationIdQuery: { organizationId: orgId } },
        ],
      }),
      'ListUsers',
    );
    const user = res.result[0];
    return (
      user && {
        id: user.userId,
        preferredLoginName: user.preferredLoginName,
        hasSecret: user.machine?.hasSecret ?? false,
      }
    );
  }

  async createHumanUser(spec: HumanSpec): Promise<UserInfo> {
    const created = parse(
      IdOnly,
      await this.transport.post(ENDPOINTS.createUser, {
        organizationId: spec.orgId,
        username: spec.username,
        human: {
          profile: {
            givenName: spec.givenName,
            familyName: spec.familyName,
            displayName: `${spec.givenName} ${spec.familyName}`,
          },
          // Verified on purpose: no mail round trip in dev.
          email: { email: spec.email, isVerified: true },
          password: { password: spec.password, changeRequired: false },
        },
      }),
      'CreateUser(human)',
    );
    // The preferred login name comes from a projection that can lag a moment behind the write.
    const deadline = Date.now() + this.projectionWaitMs;
    for (;;) {
      const user = await this.findUser(spec.orgId, spec.username);
      if (user?.preferredLoginName) return user;
      if (Date.now() > deadline)
        return { id: created.id, preferredLoginName: spec.username, hasSecret: false };
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  async createMachineUser(spec: MachineSpec): Promise<UserInfo> {
    const created = parse(
      IdOnly,
      await this.transport.post(ENDPOINTS.createUser, {
        organizationId: spec.orgId,
        username: spec.username,
        machine: {
          name: spec.name,
          description: spec.description,
          // JWT access tokens, so the API verifies machine tokens the same way as user tokens.
          accessTokenType: 'ACCESS_TOKEN_TYPE_JWT',
        },
      }),
      'CreateUser(machine)',
    );
    return { id: created.id, preferredLoginName: spec.username, hasSecret: false };
  }

  async setPassword(userId: string, password: string): Promise<void> {
    await this.transport.post(ENDPOINTS.setPassword, {
      userId,
      newPassword: { password, changeRequired: false },
    });
  }

  async addSecret(userId: string): Promise<string> {
    return parse(
      AddSecretResponse,
      await this.transport.post(ENDPOINTS.addSecret, { userId }),
      'AddSecret',
    ).clientSecret;
  }

  async findAuthorization(
    userId: string,
    projectId: string,
  ): Promise<AuthorizationInfo | undefined> {
    const res = parse(
      AuthorizationList,
      await this.transport.post(ENDPOINTS.listAuthorizations, {
        filters: [{ inUserIds: { ids: [userId] } }, { projectId: { id: projectId } }],
      }),
      'ListAuthorizations',
    );
    const auth = res.authorizations[0];
    return auth && { id: auth.id, roleKeys: auth.roles.map((r) => r.key) };
  }

  async createAuthorization(
    userId: string,
    projectId: string,
    orgId: string,
    roleKeys: string[],
  ): Promise<void> {
    await this.transport.post(ENDPOINTS.createAuthorization, {
      userId,
      projectId,
      organizationId: orgId,
      roleKeys,
    });
  }

  async updateAuthorization(authorizationId: string, roleKeys: string[]): Promise<void> {
    // Replaces the whole role set, so callers pass the complete desired list.
    await this.transport.post(ENDPOINTS.updateAuthorization, { id: authorizationId, roleKeys });
  }

  async listOrgMemberRoles(orgId: string, userId: string): Promise<string[] | undefined> {
    const res = parse(
      MemberList,
      await this.transport.post(ENDPOINTS.listOrgMembers, {}, { 'x-zitadel-orgid': orgId }),
      'ListOrgMembers',
    );
    return res.result.find((m) => m.userId === userId)?.roles;
  }

  async addOrgMember(orgId: string, userId: string, roles: string[]): Promise<void> {
    await this.transport.post(
      ENDPOINTS.addOrgMember,
      { userId, roles },
      { 'x-zitadel-orgid': orgId },
    );
  }

  async ensureStaffLoginPolicy(orgId: string): Promise<boolean> {
    const asOrg = { 'x-zitadel-orgid': orgId };
    const current = parse(
      LoginPolicyResponse,
      await this.transport.get(ENDPOINTS.orgLoginPolicy, asOrg),
      'GetLoginPolicy',
    );
    const { policy } = current;
    if (!policy.allowRegister && !policy.hidePasswordReset && policy.ignoreUnknownUsernames) {
      return false;
    }

    const body: Record<string, unknown> = {
      allowRegister: false,
      hidePasswordReset: false,
      ignoreUnknownUsernames: true,
    };
    for (const key of CARRY_OVER) if (policy[key] !== undefined) body[key] = policy[key];

    if (policy.isDefault || current.isDefault) {
      // Inherited from the instance: create the org's own policy, starting from the same settings.
      // The create request also takes the factor lists. IDP links come back without the owner type
      // the create request needs, so refuse rather than drop them silently (none exist in dev).
      if (policy.idps.length > 0) {
        throw new Error(
          'The inherited login policy has identity provider links; copy them by hand into a custom org policy.',
        );
      }
      await this.transport.post(
        ENDPOINTS.orgLoginPolicy,
        { ...body, secondFactors: policy.secondFactors, multiFactors: policy.multiFactors },
        asOrg,
      );
    } else {
      // Update has no factor or IDP lists: those have their own endpoints and stay as they are.
      await this.transport.put(ENDPOINTS.orgLoginPolicy, body, asOrg);
    }
    return true;
  }

  async ensureSmtp(spec: SmtpSpec): Promise<boolean> {
    const list = parse(
      ProviderList,
      await this.transport.post(ENDPOINTS.listEmailProviders, {}),
      'ListEmailProviders',
    );
    const existing = list.result.find((provider) => provider.description === spec.description);
    if (list.result.some((provider) => provider.state === 'EMAIL_PROVIDER_ACTIVE')) return false;
    const provider =
      existing ??
      parse(
        IdOnly,
        await this.transport.post(ENDPOINTS.addEmailProviderSmtp, {
          senderAddress: spec.senderAddress,
          senderName: spec.senderName,
          tls: false,
          host: spec.host,
          description: spec.description,
          none: {},
        }),
        'AddEmailProviderSMTP',
      );
    await this.transport.post(ENDPOINTS.activateEmailProvider(provider.id), {});
    return true;
  }

  async clientCredentialsToken(
    clientId: string,
    clientSecret: string,
    scope: string,
  ): Promise<string> {
    // RFC 6749 section 2.3.1: id and secret are form-encoded before Basic auth.
    const basic = Buffer.from(
      `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
    ).toString('base64');
    const res = await this.fetchImpl(`${this.baseUrl}${ENDPOINTS.token}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new ZitadelError(ENDPOINTS.token, res.status, text.slice(0, 200));
    return parse(TokenResponse, JSON.parse(text) as unknown, 'token endpoint').access_token;
  }
}
