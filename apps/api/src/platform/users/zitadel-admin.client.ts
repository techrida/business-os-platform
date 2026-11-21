// The API's only door into ZITADEL's management APIs, used with the `bos-provisioner` PAT.
// Serves the NFR "role assignment has one source of truth": ZITADEL grants are the truth and this
// client is how k-users reads and writes them (P1-PLAN §1).
//
// One method per ZITADEL call, so a wrong path or field found by the live probe is a one-line fix.
// Each method says which endpoint it uses and whether that shape is VERIFIED (the same call and body
// that P0's tools/seed-zitadel runs against a live v4.20.1 instance) or UNVERIFIED (from the docs
// or a guess; P1-PLAN §3 marks it [unverified]).
//
// Fails closed: without ZITADEL_PROVISIONER_TOKEN every call throws ZitadelNotConfiguredError.
import { ROLE_KEYS, type RoleKey, type UserStatusSchema } from '@bos/contracts';
import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { CoreConfig } from '../config/config';

/** Connect-protocol paths (`POST /zitadel.<pkg>.v2.<Service>/<Method>`), as in the seed. */
export const ZITADEL_ENDPOINTS = {
  // VERIFIED (seed findProject).
  listProjects: '/zitadel.project.v2.ProjectService/ListProjects',
  // UNVERIFIED: user v2 GetUserByID; body { userId }, response { user }.
  getUser: '/zitadel.user.v2.UserService/GetUserByID',
  passwordReset: '/zitadel.user.v2.UserService/PasswordReset',
  // F1-Q5. VERIFIED at v4.20.1 (2026-11-20): each path exists and takes body { userId } (an unknown id answers
  // 404 "User could not be found", an unknown method answers "404 page not found"). UNVERIFIED: a real state change
  // with this client's PAT. ZITADEL refuses a change that does not fit (deactivating an invited user, reactivating
  // an active one) with a precondition error.
  deactivateUser: '/zitadel.user.v2.UserService/DeactivateUser',
  reactivateUser: '/zitadel.user.v2.UserService/ReactivateUser',
  lockUser: '/zitadel.user.v2.UserService/LockUser',
  // VERIFIED at v4.20.1 (2026-11-20): exists and takes { userId } (an unknown id answers 404 "User could not be
  // found"). Used only to take back an identity an invite created a moment ago (UserMirror.takeBackInvite).
  deleteUser: '/zitadel.user.v2.UserService/DeleteUser',
  unlockUser: '/zitadel.user.v2.UserService/UnlockUser',
  // VERIFIED path and organizationIdQuery (seed findUser). UNVERIFIED: the `query` paging object, the
  // `sortingColumn` value and the `details.totalResult` answer. reconcile does not trust any of them:
  // it aborts when the walk shows paging is not working (see UserMirror.reconcile).
  listUsers: '/zitadel.user.v2.UserService/ListUsers',
  // VERIFIED (seed createHumanUser), minus the password: an invited user sets their own.
  createUser: '/zitadel.user.v2.UserService/CreateUser',
  // UNVERIFIED: user v2 CreateInviteCode; body { userId, sendCode: {} } makes ZITADEL send the mail.
  createInviteCode: '/zitadel.user.v2.UserService/CreateInviteCode',
  // VERIFIED (seed findAuthorization / createAuthorization / updateAuthorization).
  listAuthorizations: '/zitadel.authorization.v2.AuthorizationService/ListAuthorizations',
  createAuthorization: '/zitadel.authorization.v2.AuthorizationService/CreateAuthorization',
  updateAuthorization: '/zitadel.authorization.v2.AuthorizationService/UpdateAuthorization',
  // UNVERIFIED: authorization v2 DeleteAuthorization; body { id }. Used when the role set becomes empty.
  deleteAuthorization: '/zitadel.authorization.v2.AuthorizationService/DeleteAuthorization',
  // K8 (portal access). VERIFIED path and body (seed findOrgByName / createOrg). UNVERIFIED with this
  // client's PAT: the seed makes bos-provisioner IAM_ORG_MANAGER on the instance for these calls
  // (tools/seed-zitadel PROVISIONER_IAM_ROLES), which no live run has confirmed yet.
  listOrganizations: '/zitadel.org.v2.OrganizationService/ListOrganizations',
  addOrganization: '/zitadel.org.v2.OrganizationService/AddOrganization',
  // VERIFIED path and body (seed createProjectGrant). UNVERIFIED: that a duplicate answers HTTP 409
  // (Connect maps already_exists to 409) and that the provisioner may grant the project.
  createProjectGrant: '/zitadel.project.v2.ProjectService/CreateProjectGrant',
  // VERIFIED path and bodies (seed ensureOrgLoginPolicyNoRegister, management v1 at v4.20.1): GET =
  // GetLoginPolicy, POST = AddCustomLoginPolicy, PUT = UpdateCustomLoginPolicy, on the org named by the
  // `x-zitadel-orgid` header. UNVERIFIED with this client's PAT (needs policy.write on the customer org).
  orgLoginPolicy: '/management/v1/policies/login',
  // F1-Q4. VERIFIED GET at v4.20.1 (2026-11-20, staff org): { policy: { details, isDefault }, isDefault } with
  // the attempt limits left out while they are 0 (no lockout). UNVERIFIED: POST = AddCustomLockoutPolicy and
  // PUT = UpdateCustomLockoutPolicy with body { maxPasswordAttempts, maxOtpAttempts }, and that the provisioner
  // holds policy.write on the staff org.
  orgLockoutPolicy: '/management/v1/policies/lockout',
} as const;

/** The org lockout-policy settings a caller pins (management v1 field names). */
export interface OrgLockoutPolicy {
  maxPasswordAttempts: number;
  maxOtpAttempts: number;
}

/** The ZITADEL project that holds the role keys (tools/seed-zitadel/src/personas.ts PROJECT_NAME). */
export const BOS_PROJECT_NAME = 'business-os';

export class ZitadelNotConfiguredError extends Error {
  constructor() {
    super('ZITADEL_PROVISIONER_TOKEN is not set: user sync and admin user calls are disabled');
    this.name = 'ZitadelNotConfiguredError';
  }
}

/** Any non-2xx answer. The message never carries the PAT or the request body. */
export class ZitadelHttpError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    detail: string,
  ) {
    super(`ZITADEL ${path} answered ${status}: ${detail}`);
    this.name = 'ZitadelHttpError';
  }
}

/** Our status vocabulary (app.users.status) derived from ZITADEL's user state. */
export type MirroredStatus = z.infer<typeof UserStatusSchema>;

/** What k-users needs to know about one ZITADEL user. */
export interface ZitadelUser {
  id: string;
  /** The org that owns the user (`details.resourceOwner`). */
  orgId: string;
  email: string | null;
  displayName: string;
  /** Null when ZITADEL sent a state we do not recognise: callers leave the mirrored user unchanged. */
  status: MirroredStatus | null;
  /**
   * ZITADEL holds the user LOCKED (status 'inactive'): its lockout policy saw too many wrong passwords or codes, or
   * an admin locked them. Absent means false.
   */
  locked?: boolean;
  /** When ZITADEL last changed the user (`details.changeDate`), or null when it did not say. */
  changedAt?: Date | null;
  /** When ZITADEL created the user (`details.creationDate`), or null when it did not say. */
  createdAt: Date | null;
}

export interface ZitadelUserPage {
  users: ZitadelUser[];
  /** Offset of the next page, or null when this was the last one. */
  nextCursor: string | null;
  /** ZITADEL's own count of matching users (`details.totalResult`), or null when it sent none. */
  totalResult?: number | null;
}

/** The org login-policy settings a caller pins (management v1 field names). */
export interface OrgLoginPolicyPatch {
  allowRegister: boolean;
  forceMfa: boolean;
  forceMfaLocalOnly?: boolean;
  /** A protobuf duration such as `0s`. */
  mfaInitSkipLifetime?: string;
}

/**
 * A customer's portal org (K8): no self-registration, so nobody can sign themselves up into a customer org,
 * and MFA forced and never skippable for its users (D23 = C), the same MFA values the seed's FORCE_MFA_POLICY
 * sets on the instance. Pinned per org so a later change of the instance policy cannot open the org.
 */
export const PORTAL_LOGIN_POLICY: Readonly<OrgLoginPolicyPatch> = {
  allowRegister: false,
  forceMfa: true,
  forceMfaLocalOnly: false,
  mfaInitSkipLifetime: '0s',
};

export interface CreateHumanInput {
  email: string;
  givenName: string;
  familyName: string;
}

const Str = z.string();

// UNVERIFIED field names: `state` and `details.resourceOwner` on a user v2 object.
const UserShape = z.object({
  userId: Str.min(1),
  state: Str.default('USER_STATE_UNSPECIFIED'),
  username: Str.default(''),
  preferredLoginName: Str.default(''),
  details: z
    .object({
      resourceOwner: Str.default(''),
      creationDate: Str.optional(),
      changeDate: Str.optional(),
    })
    .default({ resourceOwner: '' }),
  human: z
    .object({
      profile: z
        .object({
          displayName: Str.default(''),
          givenName: Str.default(''),
          familyName: Str.default(''),
        })
        .optional(),
      email: z.object({ email: Str.default('') }).optional(),
    })
    .optional(),
  machine: z.object({ name: Str.default('') }).optional(),
});
type UserShape = z.infer<typeof UserShape>;

const GetUserResponse = z.object({ user: UserShape });
// UNVERIFIED: `details.totalResult` (an int64, so ZITADEL sends it as a string).
const ListUsersResponse = z.object({
  result: z.array(UserShape).default([]),
  details: z.object({ totalResult: z.union([Str, z.number()]).optional() }).optional(),
});
const IdOnly = z.object({ id: Str.min(1) });
const OrgList = z.object({ result: z.array(z.object({ id: Str.min(1), name: Str })).default([]) });
const AddOrgResponse = z.object({ organizationId: Str.min(1) });
/** ZITADEL's exact-match method for user and org queries (the seed's EQ_QUERY). */
const EQ_QUERY = 'TEXT_QUERY_METHOD_EQUALS';
const ProjectList = z.object({
  projects: z.array(z.object({ projectId: Str.min(1), name: Str })).default([]),
});
// VERIFIED: id and roles[].key (seed). UNVERIFIED: which field names the grant's org.
const AuthorizationList = z.object({
  authorizations: z
    .array(
      z.object({
        id: Str.min(1),
        roles: z.array(z.object({ key: Str })).default([]),
        organization: z.object({ id: Str }).optional(),
        organizationId: Str.optional(),
      }),
    )
    .default([]),
});
// Protobuf JSON omits false booleans and empty lists. Every other field is carried over (CARRY_OVER).
const LoginPolicyResponse = z.object({
  policy: z.looseObject({
    isDefault: z.boolean().default(false),
    allowRegister: z.boolean().default(false),
    forceMfa: z.boolean().default(false),
    forceMfaLocalOnly: z.boolean().default(false),
    secondFactors: z.array(Str).default([]),
    multiFactors: z.array(Str).default([]),
    idps: z.array(z.unknown()).default([]),
  }),
  isDefault: z.boolean().default(false),
});
// uint64 fields arrive as strings, and protobuf JSON leaves out zeros (0 = no lockout).
const Attempts = z.union([Str, z.number()]).optional();
const LockoutPolicyResponse = z.object({
  policy: z.looseObject({
    isDefault: z.boolean().default(false),
    maxPasswordAttempts: Attempts,
    maxOtpAttempts: Attempts,
  }),
  isDefault: z.boolean().default(false),
});
const attempts = (value: string | number | undefined): number => Number(value ?? 0);
/**
 * AddCustomLoginPolicy and UpdateCustomLoginPolicy replace the whole policy (proto3 scalars), so every
 * setting read must be sent back or it silently resets: allowUsernamePassword would become false and lock
 * everyone out. The same list as the seed's CARRY_OVER (tools/seed-zitadel/src/zitadel-client.ts).
 */
const CARRY_OVER = [
  'allowUsernamePassword',
  'allowExternalIdp',
  'forceMfa',
  'passwordlessType',
  'hidePasswordReset',
  'ignoreUnknownUsernames',
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
const ErrorShape = z.object({ code: Str.optional(), message: Str.optional() });

function parse<S extends z.ZodType>(schema: S, data: unknown, what: string): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new Error(`Unexpected ZITADEL response for ${what}: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}

/**
 * USER_STATE_INITIAL = created but never logged in (an open invite). Strict on purpose: only the
 * explicit INACTIVE and LOCKED states shut a user out. Anything else (UNSPECIFIED, DELETED, an empty
 * string, a state from a newer ZITADEL) is null = "unknown", and callers leave the user unchanged.
 * The old default of "not active means inactive" would lock everyone out if the field was renamed.
 */
export function statusFromState(state: string): MirroredStatus | null {
  switch (state) {
    case 'USER_STATE_ACTIVE':
      return 'active';
    case 'USER_STATE_INITIAL':
      return 'invited';
    case 'USER_STATE_INACTIVE':
    case 'USER_STATE_LOCKED':
      return 'inactive';
    default:
      return null;
  }
}

function dateOrNull(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function totalOrNull(value: string | number | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

function toUser(u: UserShape): ZitadelUser {
  const profile = u.human?.profile;
  const email = u.human?.email?.email ?? '';
  const displayName =
    profile?.displayName ||
    [profile?.givenName, profile?.familyName].filter(Boolean).join(' ') ||
    u.machine?.name ||
    u.preferredLoginName ||
    u.username;
  return {
    id: u.userId,
    orgId: u.details.resourceOwner,
    email: email.length > 0 ? email : null,
    displayName,
    status: statusFromState(u.state),
    locked: u.state === 'USER_STATE_LOCKED',
    createdAt: dateOrNull(u.details.creationDate),
    changedAt: dateOrNull(u.details.changeDate),
  };
}

const ROLE_KEY_SET: ReadonlySet<string> = new Set(ROLE_KEYS);

const PAGE_SIZE = 100;

@Injectable()
export class ZitadelAdminClient {
  private projectId: string | undefined;

  constructor(private readonly config: CoreConfig) {}

  /** The user, or null when ZITADEL says it does not exist (deleted). */
  async getUser(zitadelUserId: string): Promise<ZitadelUser | null> {
    try {
      const res = parse(
        GetUserResponse,
        await this.post(ZITADEL_ENDPOINTS.getUser, { userId: zitadelUserId }),
        'GetUserByID',
      );
      return toUser(res.user);
    } catch (error) {
      if (error instanceof ZitadelHttpError && error.status === 404) return null;
      throw error;
    }
  }

  /**
   * One page of the org's users, sorted by creation date ascending so offsets stay stable while
   * users are added (new users land at the end). The sort is sent explicitly: without it ZITADEL
   * orders by its own default and an offset walk can skip or repeat users. A short page (fewer rows
   * than asked) is the last one.
   */
  async listUsers(zitadelOrgId: string, cursor?: string | null): Promise<ZitadelUserPage> {
    const offset = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
    const res = parse(
      ListUsersResponse,
      await this.post(ZITADEL_ENDPOINTS.listUsers, {
        query: { offset: String(offset), limit: PAGE_SIZE, asc: true },
        sortingColumn: 'USER_FIELD_NAME_CREATION_DATE',
        queries: [{ organizationIdQuery: { organizationId: zitadelOrgId } }],
      }),
      'ListUsers',
    );
    const users = res.result.map(toUser);
    return {
      users,
      nextCursor: res.result.length === PAGE_SIZE ? String(offset + res.result.length) : null,
      totalResult: totalOrNull(res.details?.totalResult),
    };
  }

  /**
   * The user's role keys in our project, counted only for grants made in `zitadelOrgId` and only
   * when the key is one of ROLE_KEYS. A grant whose org cannot be read is dropped (fail closed).
   */
  async listGrants(zitadelUserId: string, zitadelOrgId: string): Promise<RoleKey[]> {
    const grants = await this.authorizations(zitadelUserId);
    const roles = new Set<RoleKey>();
    for (const grant of grants) {
      const grantOrg = grant.organization?.id ?? grant.organizationId;
      if (grantOrg !== zitadelOrgId) continue;
      for (const role of grant.roles) {
        if (ROLE_KEY_SET.has(role.key)) roles.add(role.key as RoleKey);
      }
    }
    return [...roles].sort();
  }

  /** Creates a human with an unverified email and no password; returns the ZITADEL user id. */
  async createHuman(zitadelOrgId: string, input: CreateHumanInput): Promise<string> {
    const res = parse(
      IdOnly,
      await this.post(ZITADEL_ENDPOINTS.createUser, {
        organizationId: zitadelOrgId,
        username: input.email,
        human: {
          profile: {
            givenName: input.givenName,
            familyName: input.familyName,
            displayName: `${input.givenName} ${input.familyName}`,
          },
          email: { email: input.email, isVerified: false },
        },
      }),
      'CreateUser(human)',
    );
    return res.id;
  }

  /** Replaces the user's role set in our project for `zitadelOrgId` (the whole set, not a delta). */
  async setGrants(
    zitadelUserId: string,
    zitadelOrgId: string,
    roles: readonly RoleKey[],
  ): Promise<void> {
    const existing = (await this.authorizations(zitadelUserId)).find(
      (a) => (a.organization?.id ?? a.organizationId) === zitadelOrgId,
    );
    const roleKeys = [...new Set(roles)].sort();
    if (existing && roleKeys.length === 0) {
      await this.post(ZITADEL_ENDPOINTS.deleteAuthorization, { id: existing.id });
    } else if (existing) {
      await this.post(ZITADEL_ENDPOINTS.updateAuthorization, { id: existing.id, roleKeys });
    } else if (roleKeys.length > 0) {
      await this.post(ZITADEL_ENDPOINTS.createAuthorization, {
        userId: zitadelUserId,
        projectId: await this.bosProjectId(),
        organizationId: zitadelOrgId,
        roleKeys,
      });
    }
  }

  /** The id of the org whose name is exactly `name`, or null. Org names are unique in a ZITADEL instance. */
  async findOrganizationByName(name: string): Promise<string | null> {
    const res = parse(
      OrgList,
      await this.post(ZITADEL_ENDPOINTS.listOrganizations, {
        queries: [{ nameQuery: { name, method: EQ_QUERY } }],
      }),
      'ListOrganizations(name)',
    );
    return res.result.find((o) => o.name === name)?.id ?? null;
  }

  /** Creates an org and returns its id. A taken name answers ZitadelHttpError 409. */
  async createOrganization(name: string): Promise<string> {
    return parse(
      AddOrgResponse,
      await this.post(ZITADEL_ENDPOINTS.addOrganization, { name }),
      'AddOrganization',
    ).organizationId;
  }

  /**
   * Grants our project to `zitadelOrgId` with `roles`, so users of that org can hold those roles (the seed
   * does the same for its customer and vendor orgs). An existing grant counts as done: it is left as it is.
   */
  async ensureProjectGrant(zitadelOrgId: string, roles: readonly RoleKey[]): Promise<void> {
    try {
      await this.post(ZITADEL_ENDPOINTS.createProjectGrant, {
        projectId: await this.bosProjectId(),
        grantedOrganizationId: zitadelOrgId,
        roleKeys: [...new Set(roles)].sort(),
      });
    } catch (error) {
      if (error instanceof ZitadelHttpError && error.status === 409) return;
      throw error;
    }
  }

  /** The user of `zitadelOrgId` whose username is exactly `username`, or null. */
  async findHumanByUsername(zitadelOrgId: string, username: string): Promise<ZitadelUser | null> {
    const res = parse(
      ListUsersResponse,
      await this.post(ZITADEL_ENDPOINTS.listUsers, {
        queries: [
          { userNameQuery: { userName: username, method: EQ_QUERY } },
          { organizationIdQuery: { organizationId: zitadelOrgId } },
        ],
      }),
      'ListUsers(username)',
    );
    // Checked again here: a query field ZITADEL ignored must not hand back somebody else.
    const found = res.result.find(
      (u) => u.username === username && u.details.resourceOwner === zitadelOrgId,
    );
    return found ? toUser(found) : null;
  }

  /**
   * Pins `patch` in the org's own login policy. An org that inherits the instance policy gets a custom one
   * (even when the inherited values already match, so a later instance change cannot open the org); a custom
   * policy that differs is updated; a matching custom policy is left alone. Every call names the org in
   * `x-zitadel-orgid`: without it management v1 acts on the provisioner's own org, the staff org.
   */
  async ensureOrgLoginPolicy(
    zitadelOrgId: string,
    patch: Readonly<OrgLoginPolicyPatch>,
  ): Promise<'created' | 'updated' | 'unchanged'> {
    const asOrg = { 'x-zitadel-orgid': zitadelOrgId };
    const current = parse(
      LoginPolicyResponse,
      await this.request('GET', ZITADEL_ENDPOINTS.orgLoginPolicy, undefined, asOrg),
      'GetLoginPolicy',
    );
    const { policy } = current;
    const inherited = policy.isDefault || current.isDefault;
    const matches = Object.entries(patch).every(([key, value]) => policy[key] === value);
    if (!inherited && matches) return 'unchanged';

    const body: Record<string, unknown> = {};
    for (const key of CARRY_OVER) if (policy[key] !== undefined) body[key] = policy[key];
    Object.assign(body, patch);

    if (inherited) {
      // The create request also takes the factor lists. IDP links come back without the owner type the
      // create request needs, so refuse rather than drop them silently (fail closed: no user is made).
      if (policy.idps.length > 0) {
        throw new Error(
          `The login policy inherited by ZITADEL org ${zitadelOrgId} has identity provider links; ` +
            'copy them by hand into a custom org policy',
        );
      }
      try {
        await this.request(
          'POST',
          ZITADEL_ENDPOINTS.orgLoginPolicy,
          { ...body, secondFactors: policy.secondFactors, multiFactors: policy.multiFactors },
          asOrg,
        );
        return 'created';
      } catch (error) {
        // A concurrent grant created the custom policy a moment ago: update that one instead.
        if (!(error instanceof ZitadelHttpError && error.status === 409)) throw error;
      }
    }
    // Update has no factor or IDP lists: those have their own endpoints and stay as they are.
    await this.request('PUT', ZITADEL_ENDPOINTS.orgLoginPolicy, body, asOrg);
    return 'updated';
  }

  /** Asks ZITADEL to mail the invite link (the user then sets a password and enrols TOTP). */
  async sendInviteCode(zitadelUserId: string): Promise<void> {
    await this.post(ZITADEL_ENDPOINTS.createInviteCode, { userId: zitadelUserId, sendCode: {} });
  }

  /** Shuts the user out of every sign-in (state INACTIVE) until reactivated. */
  async deactivateUser(zitadelUserId: string): Promise<void> {
    await this.post(ZITADEL_ENDPOINTS.deactivateUser, { userId: zitadelUserId });
  }

  /** Lets a deactivated user sign in again (state ACTIVE). */
  async reactivateUser(zitadelUserId: string): Promise<void> {
    await this.post(ZITADEL_ENDPOINTS.reactivateUser, { userId: zitadelUserId });
  }

  /** Removes the user from ZITADEL for good: their invite link and sign-in stop working. */
  async deleteUser(zitadelUserId: string): Promise<void> {
    await this.post(ZITADEL_ENDPOINTS.deleteUser, { userId: zitadelUserId });
  }

  /** Shuts the user out of every sign-in (state LOCKED) until unlocked. */
  async lockUser(zitadelUserId: string): Promise<void> {
    await this.post(ZITADEL_ENDPOINTS.lockUser, { userId: zitadelUserId });
  }

  /** Lets a locked user sign in again (state ACTIVE) and resets their failed attempts. */
  async unlockUser(zitadelUserId: string): Promise<void> {
    await this.post(ZITADEL_ENDPOINTS.unlockUser, { userId: zitadelUserId });
  }

  /**
   * Pins the attempt limits in the org's own lockout policy (F1-Q4), the same way ensureOrgLoginPolicy pins the login
   * policy: an org that inherits the instance policy gets a custom one, a custom one that differs is updated, and a
   * matching custom one is left alone. The org is named in `x-zitadel-orgid`.
   */
  async ensureOrgLockoutPolicy(
    zitadelOrgId: string,
    want: Readonly<OrgLockoutPolicy>,
  ): Promise<'created' | 'updated' | 'unchanged'> {
    const asOrg = { 'x-zitadel-orgid': zitadelOrgId };
    const current = parse(
      LockoutPolicyResponse,
      await this.request('GET', ZITADEL_ENDPOINTS.orgLockoutPolicy, undefined, asOrg),
      'GetLockoutPolicy',
    );
    const { policy } = current;
    const inherited = policy.isDefault || current.isDefault;
    const matches =
      attempts(policy.maxPasswordAttempts) === want.maxPasswordAttempts &&
      attempts(policy.maxOtpAttempts) === want.maxOtpAttempts;
    if (!inherited && matches) return 'unchanged';
    const body = { ...policy, ...want };
    delete (body as Record<string, unknown>).details;
    delete (body as Record<string, unknown>).isDefault;
    if (inherited) {
      try {
        await this.request('POST', ZITADEL_ENDPOINTS.orgLockoutPolicy, body, asOrg);
        return 'created';
      } catch (error) {
        // Another process created the custom policy a moment ago: update that one instead.
        if (!(error instanceof ZitadelHttpError && error.status === 409)) throw error;
      }
    }
    await this.request('PUT', ZITADEL_ENDPOINTS.orgLockoutPolicy, body, asOrg);
    return 'updated';
  }

  async sendPasswordReset(zitadelUserId: string): Promise<void> {
    await this.post(ZITADEL_ENDPOINTS.passwordReset, {
      userId: zitadelUserId,
      sendLink: { notificationType: 'NOTIFICATION_TYPE_Email' },
    });
  }

  private async authorizations(zitadelUserId: string) {
    return parse(
      AuthorizationList,
      await this.post(ZITADEL_ENDPOINTS.listAuthorizations, {
        filters: [
          { inUserIds: { ids: [zitadelUserId] } },
          { projectId: { id: await this.bosProjectId() } },
        ],
      }),
      'ListAuthorizations',
    ).authorizations;
  }

  /** Found by name once per process; the project id never changes after the seed created it. */
  private async bosProjectId(): Promise<string> {
    if (this.projectId) return this.projectId;
    const res = parse(
      ProjectList,
      await this.post(ZITADEL_ENDPOINTS.listProjects, {
        filters: [
          {
            projectNameFilter: {
              projectName: BOS_PROJECT_NAME,
              method: 'TEXT_FILTER_METHOD_EQUALS',
            },
          },
        ],
      }),
      'ListProjects',
    );
    const project = res.projects.find((p) => p.name === BOS_PROJECT_NAME);
    if (!project) throw new Error(`ZITADEL project "${BOS_PROJECT_NAME}" not found; run the seed`);
    this.projectId = project.projectId;
    return project.projectId;
  }

  private post(path: string, body: unknown): Promise<unknown> {
    return this.request('POST', path, body);
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<unknown> {
    const token = this.config.ZITADEL_PROVISIONER_TOKEN;
    if (!token) throw new ZitadelNotConfiguredError();
    const base = this.config.ZITADEL_API_URL.replace(/\/+$/, '');
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...headers,
        'content-type': 'application/json',
        'connect-protocol-version': '1',
        authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // A hung ZITADEL must not hold a worker slot or an admin request forever.
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        const parsed = ErrorShape.safeParse(JSON.parse(text));
        if (parsed.success)
          detail = `${parsed.data.code ?? ''} ${parsed.data.message ?? ''}`.trim();
      } catch {
        // Not JSON (a proxy error page): keep the truncated text.
      }
      throw new ZitadelHttpError(path, res.status, detail);
    }
    return text.length > 0 ? (JSON.parse(text) as unknown) : {};
  }
}
