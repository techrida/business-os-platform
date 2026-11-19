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
  instanceLoginPolicy: '/admin/v1/policies/login',

  // admin v1 (REST) instance members (K8). UNVERIFIED: ListIAMMembers / AddIAMMember as named in
  // proto/zitadel/admin.proto (`POST /admin/v1/members/_search`, `POST /admin/v1/members` { userId, roles });
  // not yet called against a live instance.
  listIamMembers: '/admin/v1/members/_search',
  addIamMember: '/admin/v1/members',

  // admin v1 (REST): `AddSMTPConfig` is deprecated in favour of the email-provider endpoints.
  listEmailProviders: '/admin/v1/email/_search',
  addEmailProviderSmtp: '/admin/v1/email/smtp',
  activateEmailProvider: (id: string) => `/admin/v1/email/${encodeURIComponent(id)}/_activate`,

  // OIDC token endpoint (standard, not a ZITADEL API).
  token: '/oauth/v2/token',

  // ---- P1 additions (U6b). Every path below is UNVERIFIED (P1-PLAN section 3) until the lead's
  // live probe; the REST-style paths are plain HTTP verbs, not Connect `POST /<pkg>.<Service>/<Method>`.
  // user v2 REST
  registerTotp: (userId: string) => `/v2/users/${encodeURIComponent(userId)}/totp`,
  verifyTotp: (userId: string) => `/v2/users/${encodeURIComponent(userId)}/totp/verify`,
  listAuthMethods: (userId: string) =>
    `/v2/users/${encodeURIComponent(userId)}/authentication_methods`,
  deactivateUser: (userId: string) => `/v2/users/${encodeURIComponent(userId)}/deactivate`,
  // admin v1 REST
  loginPolicy: '/admin/v1/policies/login',
  loginSecondFactors: '/admin/v1/policies/login/second_factors',
  oidcSettings: '/admin/v1/settings/oidc',
  // management v1 REST
  pats: (userId: string) => `/management/v1/users/${encodeURIComponent(userId)}/pats`,
  searchPats: (userId: string) => `/management/v1/users/${encodeURIComponent(userId)}/pats/_search`,
  // actions v2 REST
  targets: '/v2/actions/targets',
  searchTargets: '/v2/actions/targets/search',
  executions: '/v2/actions/executions',
} as const;

/** Thrown for any non-2xx answer. The message never contains the PAT or a request body. */
export class ZitadelError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    /** The server's `code message` (or truncated text). Callers match on this, not on `message`, so the path never produces a false hit. */
    readonly detail: string,
  ) {
    super(`ZITADEL ${path} answered ${status}: ${detail}`);
    this.name = 'ZitadelError';
  }
}

export interface Transport {
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<unknown>;
  /**
   * REST only: management v1 has no Connect endpoints, so reads there are plain GETs; P1 adds
   * admin v1 and user v2 reads.
   */
  get(path: string, headers?: Record<string, string>): Promise<unknown>;
  /** REST only (management v1, admin v1 and actions v2 replace-style writes). */
  put(path: string, body: unknown, headers?: Record<string, string>): Promise<unknown>;
}

const ErrorBodySchema = z.object({ code: z.string().optional(), message: z.string().optional() });

export function createFetchTransport(
  baseUrl: string,
  pat: string,
  fetchImpl: typeof fetch = fetch,
): Transport {
  const base = baseUrl.replace(/\/+$/, '');
  // One code path for every verb, so the PAT handling and error shaping cannot drift apart.
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
      // A GET carries no body: fetch rejects one, and the REST gateway would ignore it anyway.
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
  ensureInstancePasswordReset(): Promise<boolean>;
  ensureStaffLoginPolicy(orgId: string): Promise<boolean>;

  /**
   * Pins the org's login policy to `patch`. An inherited policy always becomes a custom one (so a later
   * change of the instance policy cannot reach the org), a custom one that differs is updated, and a
   * matching custom one is left alone. Returns true when it wrote something, false when nothing changed.
   */
  ensureOrgLoginPolicy(orgId: string, patch: Readonly<OrgLoginPolicyPatch>): Promise<boolean>;

  /** Returns true when a provider was created (false: already present). */
  ensureSmtp(spec: SmtpSpec): Promise<boolean>;

  /** Client-credentials token, returned only to the caller; never log it. */
  clientCredentialsToken(clientId: string, clientSecret: string, scope: string): Promise<string>;
}

// ---------------------------------------------------------------------------------------------
// P1 additions (U6b): MFA, login policy, token lifetime, PATs, Actions v2 and user retirement.
//
// A separate interface (not more members on `ZitadelApi`) so the P0 fakes that implement
// `ZitadelApi` keep compiling. The seed's `index.ts` takes `ZitadelApi & ZitadelP1Api`.
// `listOrgMemberRoles` (needed to check ORG_OWNER) and the user-grant calls
// (`findAuthorization` / `createAuthorization` / `updateAuthorization`) already exist on
// `ZitadelApi`, so they are not repeated here.

/** Loose on purpose: ZITADEL adds fields, and an update must send back every field it read. */
export type LoginPolicy = Record<string, unknown> & {
  forceMfa?: boolean;
  forceMfaLocalOnly?: boolean;
  mfaInitSkipLifetime?: string;
  passwordlessType?: string;
};
export type OidcSettings = Record<string, unknown> & {
  accessTokenLifetime?: string;
  idTokenLifetime?: string;
  refreshTokenIdleExpiration?: string;
  refreshTokenExpiration?: string;
};
export type SecondFactorType =
  | 'SECOND_FACTOR_TYPE_OTP'
  | 'SECOND_FACTOR_TYPE_U2F'
  | 'SECOND_FACTOR_TYPE_OTP_EMAIL'
  | 'SECOND_FACTOR_TYPE_OTP_SMS';
/** The org login-policy settings a caller pins (management v1 field names). */
export interface OrgLoginPolicyPatch {
  allowRegister: boolean;
  forceMfa: boolean;
  forceMfaLocalOnly?: boolean;
  /** A protobuf duration such as `0s`. */
  mfaInitSkipLifetime?: string;
}
/**
 * The customer org's portal login policy: no self-registration, MFA forced and never skippable.
 * Duplicated from PORTAL_LOGIN_POLICY in apps/api/src/platform/users/zitadel-admin.client.ts (the seed
 * cannot import the API); keep the two in step.
 */
export const PORTAL_LOGIN_POLICY: Readonly<OrgLoginPolicyPatch> = {
  allowRegister: false,
  forceMfa: true,
  forceMfaLocalOnly: false,
  mfaInitSkipLifetime: '0s',
};
/** The login-policy values U6 wants: MFA required for everyone, never skippable. */
export const FORCE_MFA_POLICY: LoginPolicy = {
  forceMfa: true,
  forceMfaLocalOnly: false,
  mfaInitSkipLifetime: '0s',
};
export interface TotpRegistration {
  /** `otpauth://totp/...` URI (what a QR code encodes). */
  uri: string;
  /** Base32 secret; feed it to `totpCode()`. Secret material: never log it. */
  secret: string;
}
export interface PatInfo {
  id: string;
  /** RFC 3339 timestamp, absent when the PAT never expires. */
  expirationDate?: string;
}
export interface CreatedPat {
  tokenId: string;
  /** The token itself, only ever returned here. Never log it. */
  token: string;
}
export interface TargetSpec {
  name: string;
  endpoint: string;
  timeout: string;
  /** Fire-and-forget delivery: ZITADEL does not wait for or check the answer. */
  restAsync: Record<string, never>;
}
export interface TargetInfo {
  id: string;
  name: string;
  endpoint: string;
}
export interface CreatedTarget {
  id: string;
  /** HMAC key for `ZITADEL-Signature`, only returned on create or update. Never log it. */
  signingKey: string;
}
/** The `condition` object of `SetExecution`, e.g. `{ event: { group: 'user' } }`. */
export type ExecutionCondition = Record<string, unknown>;

export interface ZitadelP1Api {
  /** User v2 `POST /v2/users/{userId}/totp`: starts an authenticator registration. */
  registerTotp(userId: string): Promise<TotpRegistration>;
  /** User v2 `POST /v2/users/{userId}/totp/verify` `{ code }`: completes the registration. */
  verifyTotpRegistration(userId: string, code: string): Promise<void>;
  /** User v2 `GET /v2/users/{userId}/authentication_methods`; TOTP is `AUTHENTICATION_METHOD_TYPE_TOTP`. */
  listAuthMethods(userId: string): Promise<string[]>;

  /** Admin v1 `GET /admin/v1/policies/login`. */
  getLoginPolicy(): Promise<LoginPolicy>;
  /** Admin v1 `PUT /admin/v1/policies/login` with the current policy merged with `patch`. True when a write happened, false when nothing differed. */
  updateLoginPolicy(patch: LoginPolicy): Promise<boolean>;
  /** Admin v1 `POST /admin/v1/policies/login/second_factors`. True when added, false when it already existed. */
  addSecondFactor(type: SecondFactorType): Promise<boolean>;

  /** Admin v1 `GET /admin/v1/settings/oidc`. */
  getOidcSettings(): Promise<OidcSettings>;
  /** Admin v1 `PUT /admin/v1/settings/oidc` with the current settings merged with `patch`. True when a write happened. */
  updateOidcSettings(patch: OidcSettings): Promise<boolean>;

  /** Management v1 `POST /management/v1/users/{userId}/pats`. `orgId` adds `x-zitadel-orgid`. */
  addPat(userId: string, expirationDate: string, orgId?: string): Promise<CreatedPat>;
  /** Management v1 `POST /management/v1/users/{userId}/pats/_search`. */
  listPats(userId: string, orgId?: string): Promise<PatInfo[]>;

  /** Actions v2 `POST /v2/actions/targets`. */
  createTarget(spec: TargetSpec): Promise<CreatedTarget>;
  /** Actions v2 `POST /v2/actions/targets/search`. The signing key is not part of the answer. */
  listTargets(): Promise<TargetInfo[]>;
  /** Actions v2 `PUT /v2/actions/executions` `{ condition, targets }` (replaces the target list). */
  setExecution(condition: ExecutionCondition, targetIds: string[]): Promise<void>;
  /** Tries the user-event condition shapes in order; returns the one ZITADEL accepted. */
  setUserEventExecution(targetId: string): Promise<ExecutionCondition>;

  /** User v2 `POST /v2/users/{userId}/deactivate`. True when deactivated, false when it already was. */
  deactivateUser(userId: string): Promise<boolean>;
}

/**
 * K8 (portal access) addition: instance-level (IAM) membership. A separate interface for the same reason as
 * ZitadelP1Api. The seed's own identity (`bos-bootstrap-sa`) is IAM_OWNER, so it may add IAM members.
 */
export interface ZitadelInstanceApi {
  /** Admin v1 `POST /admin/v1/members/_search`. The user's instance roles, or undefined when not a member. */
  listIamMemberRoles(userId: string): Promise<string[] | undefined>;
  /** Admin v1 `POST /admin/v1/members` `{ userId, roles }`. Fails when the user is already a member. */
  addIamMember(userId: string, roles: string[]): Promise<void>;
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
function loginPolicyWithPrivateReset(
  policy: z.infer<typeof LoginPolicyResponse>['policy'],
  allowRegister: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    allowRegister,
    hidePasswordReset: false,
    ignoreUnknownUsernames: true,
  };
  for (const key of CARRY_OVER) if (policy[key] !== undefined) body[key] = policy[key];
  return body;
}

const TokenResponse = z.object({ access_token: Str.min(1) });
const TotpRegistrationResponse = z.object({ uri: Str.min(1), secret: Str.min(1) });
const AuthMethodList = z.object({ authMethodTypes: z.array(Str).default([]) });
// The instance (admin v1) login policy, kept as a plain record; the org (management v1) one above is typed.
const AdminLoginPolicyResponse = z.object({ policy: z.record(z.string(), z.unknown()) });
const OidcSettingsResponse = z.object({ settings: z.record(z.string(), z.unknown()) });
const CreatePatResponse = z.object({ tokenId: Str.min(1), token: Str.min(1) });
const PatList = z.object({
  result: z.array(z.object({ id: Str.min(1), expirationDate: Str.optional() })).default([]),
});
const CreateTargetResponse = z.object({ id: Str.min(1), signingKey: Str.min(1) });
const TargetList = z.object({
  targets: z
    .array(z.object({ id: Str.min(1), name: Str.default(''), endpoint: Str.default('') }))
    .default([]),
});

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

/** Read-only fields of the admin v1 GET answers; a PUT must not echo them back. */
const READ_ONLY_FIELDS = ['details', 'isDefault'];

/** Proto3 JSON omits default scalars. Named enum defaults depend on the field, not their spelling. */
function sameValue(current: unknown, wanted: unknown, field: string): boolean {
  if (current === undefined) {
    return (
      wanted === false ||
      wanted === 0 ||
      wanted === '' ||
      wanted === '0s' ||
      (field === 'passwordlessType' && wanted === 'PASSWORDLESS_TYPE_NOT_ALLOWED')
    );
  }
  return current === wanted;
}

/** Merge `patch` over what ZITADEL returned, so fields the seed does not manage survive. */
function mergeSettings<T extends Record<string, unknown>>(
  current: Record<string, unknown>,
  patch: T,
): { next: Record<string, unknown>; changed: boolean } {
  const next: Record<string, unknown> = { ...current };
  for (const field of READ_ONLY_FIELDS) delete next[field];
  const changed = Object.entries(patch).some(
    ([key, value]) => !sameValue(current[key], value, key),
  );
  return { next: { ...next, ...patch }, changed };
}

function isAlreadyExists(error: unknown): boolean {
  return (
    error instanceof ZitadelError &&
    (error.status === 409 || /already[\s_-]?exists?/i.test(error.detail))
  );
}

function isAlreadyDeactivated(error: unknown): boolean {
  return (
    error instanceof ZitadelError &&
    [400, 409, 412].includes(error.status) &&
    /already|inactive|deactivated/i.test(error.detail)
  );
}

/**
 * Event conditions to try for "any user event", most specific first. The Actions v2 reference
 * does not pin the shape (P1-PLAN section 3), so the seed asks the server instead of guessing.
 */
const USER_EVENT_CONDITIONS: readonly ExecutionCondition[] = [
  { event: { group: 'user' } },
  { event: { event: 'user.human.added' } },
  { event: { all: true } },
];

export class ZitadelClient implements ZitadelApi, ZitadelP1Api, ZitadelInstanceApi {
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

  async listIamMemberRoles(userId: string): Promise<string[] | undefined> {
    // Instance members are a handful, so the first page is all of them; matched here, like org members.
    const res = parse(
      MemberList,
      await this.transport.post(ENDPOINTS.listIamMembers, {}),
      'ListIAMMembers',
    );
    return res.result.find((m) => m.userId === userId)?.roles;
  }

  async addIamMember(userId: string, roles: string[]): Promise<void> {
    await this.transport.post(ENDPOINTS.addIamMember, { userId, roles });
  }

  async ensureInstancePasswordReset(): Promise<boolean> {
    const { policy } = parse(
      LoginPolicyResponse,
      await this.transport.get(ENDPOINTS.instanceLoginPolicy),
      'Get instance login policy',
    );
    if (!policy.hidePasswordReset && policy.ignoreUnknownUsernames) return false;

    await this.transport.put(
      ENDPOINTS.instanceLoginPolicy,
      loginPolicyWithPrivateReset(policy, policy.allowRegister),
    );
    return true;
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

    const body = loginPolicyWithPrivateReset(policy, false);

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

  async ensureOrgLoginPolicy(
    orgId: string,
    patch: Readonly<OrgLoginPolicyPatch>,
  ): Promise<boolean> {
    const asOrg = { 'x-zitadel-orgid': orgId };
    const current = parse(
      LoginPolicyResponse,
      await this.transport.get(ENDPOINTS.orgLoginPolicy, asOrg),
      'GetLoginPolicy',
    );
    const { policy } = current;
    const inherited = policy.isDefault || current.isDefault;
    const matches = Object.entries(patch).every(([key, value]) =>
      sameValue(policy[key], value, key),
    );
    if (!inherited && matches) return false;

    const body: Record<string, unknown> = {};
    for (const key of CARRY_OVER) if (policy[key] !== undefined) body[key] = policy[key];
    Object.assign(body, patch);

    if (inherited) {
      // Same refusal as ensureStaffLoginPolicy: IDP links cannot be copied faithfully.
      if (policy.idps.length > 0) {
        throw new Error(
          'The inherited login policy has identity provider links; copy them by hand into a custom org policy.',
        );
      }
      try {
        await this.transport.post(
          ENDPOINTS.orgLoginPolicy,
          { ...body, secondFactors: policy.secondFactors, multiFactors: policy.multiFactors },
          asOrg,
        );
        return true;
      } catch (error) {
        // The custom policy appeared in the meantime: update that one instead.
        if (!(error instanceof ZitadelError && error.status === 409)) throw error;
      }
    }
    // Update has no factor or IDP lists: those have their own endpoints and stay as they are.
    await this.transport.put(ENDPOINTS.orgLoginPolicy, body, asOrg);
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

  // ---- P1 additions (U6b). Every method below is UNVERIFIED (P1-PLAN section 3): no path here
  // is confirmed in facts/zitadel-api.md, so the lead's live probe is what proves them.

  /** POST /v2/users/{userId}/totp. UNVERIFIED (P1-PLAN §3). */
  async registerTotp(userId: string): Promise<TotpRegistration> {
    return parse(
      TotpRegistrationResponse,
      await this.transport.post(ENDPOINTS.registerTotp(userId), {}),
      'RegisterTOTP',
    );
  }

  /** POST /v2/users/{userId}/totp/verify with `{ code }`. UNVERIFIED (P1-PLAN §3). */
  async verifyTotpRegistration(userId: string, code: string): Promise<void> {
    await this.transport.post(ENDPOINTS.verifyTotp(userId), { code });
  }

  /** GET /v2/users/{userId}/authentication_methods. UNVERIFIED (P1-PLAN §3). */
  async listAuthMethods(userId: string): Promise<string[]> {
    return parse(
      AuthMethodList,
      await this.transport.get(ENDPOINTS.listAuthMethods(userId)),
      'ListAuthenticationMethodTypes',
    ).authMethodTypes;
  }

  /** GET /admin/v1/policies/login. UNVERIFIED (P1-PLAN §3). */
  async getLoginPolicy(): Promise<LoginPolicy> {
    return parse(
      AdminLoginPolicyResponse,
      await this.transport.get(ENDPOINTS.loginPolicy),
      'GetLoginPolicy',
    ).policy;
  }

  /**
   * PUT /admin/v1/policies/login. UNVERIFIED (P1-PLAN §3).
   * The PUT replaces the whole policy, so the current one is read first and `patch` merged over
   * it; otherwise changing `forceMfa` would silently reset every other login setting.
   * Skips the write when nothing differs (ZITADEL answers "not changed" with an error).
   */
  async updateLoginPolicy(patch: LoginPolicy): Promise<boolean> {
    const current = await this.getLoginPolicy();
    const { next, changed } = mergeSettings(current, patch);
    if (!changed) return false;
    try {
      await this.transport.put(ENDPOINTS.loginPolicy, next);
    } catch (error) {
      if (error instanceof ZitadelError && /not\s+changed|no\s+changes/i.test(error.detail))
        return false;
      throw error;
    }
    return true;
  }

  /** POST /admin/v1/policies/login/second_factors. "Already exists" is success. UNVERIFIED (P1-PLAN §3). */
  async addSecondFactor(type: SecondFactorType): Promise<boolean> {
    try {
      await this.transport.post(ENDPOINTS.loginSecondFactors, { type });
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }
    return true;
  }

  /** GET /admin/v1/settings/oidc. UNVERIFIED (P1-PLAN §3). */
  async getOidcSettings(): Promise<OidcSettings> {
    return parse(
      OidcSettingsResponse,
      await this.transport.get(ENDPOINTS.oidcSettings),
      'GetOIDCSettings',
    ).settings;
  }

  /**
   * PUT /admin/v1/settings/oidc. UNVERIFIED (P1-PLAN §3).
   * Merged over the current settings so the other lifetimes stay as they are.
   */
  async updateOidcSettings(patch: OidcSettings): Promise<boolean> {
    const current = await this.getOidcSettings();
    const { next, changed } = mergeSettings(current, patch);
    if (!changed) return false;
    await this.transport.put(ENDPOINTS.oidcSettings, next);
    return true;
  }

  /** POST /management/v1/users/{userId}/pats. UNVERIFIED (P1-PLAN §3). */
  async addPat(userId: string, expirationDate: string, orgId?: string): Promise<CreatedPat> {
    return parse(
      CreatePatResponse,
      await this.transport.post(
        ENDPOINTS.pats(userId),
        { expirationDate },
        orgId ? { 'x-zitadel-orgid': orgId } : undefined,
      ),
      'AddPersonalAccessToken',
    );
  }

  /** POST /management/v1/users/{userId}/pats/_search. UNVERIFIED (P1-PLAN §3). */
  async listPats(userId: string, orgId?: string): Promise<PatInfo[]> {
    const res = parse(
      PatList,
      await this.transport.post(
        ENDPOINTS.searchPats(userId),
        {},
        orgId ? { 'x-zitadel-orgid': orgId } : undefined,
      ),
      'ListPersonalAccessTokens',
    );
    return res.result.map((p) => ({
      id: p.id,
      ...(p.expirationDate === undefined ? {} : { expirationDate: p.expirationDate }),
    }));
  }

  /** POST /v2/actions/targets. UNVERIFIED (P1-PLAN §3). */
  async createTarget(spec: TargetSpec): Promise<CreatedTarget> {
    return parse(
      CreateTargetResponse,
      await this.transport.post(ENDPOINTS.targets, spec),
      'CreateTarget',
    );
  }

  /** POST /v2/actions/targets/search. UNVERIFIED (P1-PLAN §3). */
  async listTargets(): Promise<TargetInfo[]> {
    return parse(TargetList, await this.transport.post(ENDPOINTS.searchTargets, {}), 'ListTargets')
      .targets;
  }

  /** PUT /v2/actions/executions with `{ condition, targets }`. UNVERIFIED (P1-PLAN §3). */
  async setExecution(condition: ExecutionCondition, targetIds: string[]): Promise<void> {
    await this.transport.put(ENDPOINTS.executions, { condition, targets: targetIds });
  }

  /**
   * PUT /v2/actions/executions, once per candidate condition shape. UNVERIFIED (P1-PLAN §3).
   * Stops at the first 2xx and returns that shape, so the seed can log which one this ZITADEL
   * version takes. Only "bad request" answers move on to the next shape: a 401/403/5xx is not
   * about the shape, so it is thrown straight away.
   */
  async setUserEventExecution(targetId: string): Promise<ExecutionCondition> {
    const rejected: string[] = [];
    for (const condition of USER_EVENT_CONDITIONS) {
      try {
        await this.setExecution(condition, [targetId]);
        return condition;
      } catch (error) {
        if (!(error instanceof ZitadelError) || (error.status !== 400 && error.status !== 422))
          throw error;
        rejected.push(`${JSON.stringify(condition)} -> ${error.status} ${error.detail}`);
      }
    }
    throw new Error(`ZITADEL rejected every user-event condition shape: ${rejected.join('; ')}`);
  }

  /** POST /v2/users/{userId}/deactivate. "Already deactivated" is success. UNVERIFIED (P1-PLAN §3). */
  async deactivateUser(userId: string): Promise<boolean> {
    try {
      await this.transport.post(ENDPOINTS.deactivateUser(userId), {});
    } catch (error) {
      if (isAlreadyDeactivated(error)) return false;
      throw error;
    }
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
