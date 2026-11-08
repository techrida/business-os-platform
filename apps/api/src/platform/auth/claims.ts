import { ROLE_KEYS, type RoleKey } from '@bos/contracts';
import type { Request } from 'express';
import type { JWTPayload } from 'jose';

/** ZITADEL puts the id of the user's own organization (its "resource owner") in this claim. */
export const ORG_ID_CLAIM = 'urn:zitadel:iam:user:resourceowner:id';

/** Roles for the project(s) in the token audience: `{ [roleKey]: { [orgId]: orgDomain } }`. */
export const PROJECT_ROLES_CLAIM = 'urn:zitadel:iam:org:project:roles';

/** The same shape, scoped to one project id. */
export const projectRolesClaim = (projectId: string): string =>
  `urn:zitadel:iam:org:project:${projectId}:roles`;

/** What the guard learns from a verified token. Tenancy (U4b) turns this into a RequestContext. */
export interface AuthIdentity {
  /** ZITADEL user id (`sub`). */
  readonly userId: string;
  /** ZITADEL organization id of the user. */
  readonly zitadelOrgId: string;
  /** Project role keys, sorted and de-duplicated. P0 keeps roles from every org; P1 authz refines. */
  readonly roles: readonly string[];
  /**
   * P1 roles per ZITADEL org id (see `MappedClaims.rolesByOrg`). Optional only so P0's guard,
   * which builds this object, still compiles until it copies the field across. Absent means "no
   * roles in any org": the authz interceptor must deny, never fall back to `roles`.
   */
  readonly rolesByOrg?: RolesByOrg;
  /** Token expiry, seconds since the epoch (`exp`). */
  readonly tokenExp: number;
}

/** An Express request after the AuthGuard ran. `auth` is unset on public routes. */
export type AuthenticatedRequest = Request & { auth?: AuthIdentity };

/** ZITADEL org id -> the known role keys granted in that org, sorted and de-duplicated. */
export type RolesByOrg = Readonly<Record<string, readonly RoleKey[]>>;

export interface MappedClaims {
  readonly userId: string;
  /** `null` when the token carries no usable org claim; the guard answers that with 403. */
  readonly zitadelOrgId: string | null;
  /** P0's flat union of role keys from every org, unknown keys included. Kept for the P0 guard. */
  readonly roles: readonly string[];
  /**
   * Roles per org, so a role granted in org B never counts in org A (P1 plan finding 4).
   * Only keys in `ROLE_KEYS` count: an unknown key in the token grants nothing.
   */
  readonly rolesByOrg: RolesByOrg;
}

/** Thrown when a verified token still lacks a usable `sub`. The guard maps it to 401. */
export class InvalidClaimsError extends Error {
  override readonly name = 'InvalidClaimsError';
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const roleKeys = (claim: unknown): string[] => (isPlainObject(claim) ? Object.keys(claim) : []);

const KNOWN_ROLES: ReadonlySet<string> = new Set(ROLE_KEYS);

/**
 * Inverts the roles claims `{ role: { orgId: domain } }` into `{ orgId: [role, ...] }`.
 * A role whose value is not an object names no org, so it grants nothing anywhere.
 */
function groupRolesByOrg(claims: readonly unknown[]): RolesByOrg {
  const byOrg = new Map<string, Set<RoleKey>>();
  for (const claim of claims) {
    if (!isPlainObject(claim)) continue;
    for (const [role, orgs] of Object.entries(claim)) {
      if (!KNOWN_ROLES.has(role) || !isPlainObject(orgs)) continue;
      for (const orgId of Object.keys(orgs)) {
        if (orgId.length === 0) continue;
        let set = byOrg.get(orgId);
        if (set === undefined) {
          set = new Set();
          byOrg.set(orgId, set);
        }
        set.add(role as RoleKey);
      }
    }
  }
  // A null-prototype object, so a lookup like `rolesByOrg['constructor']` finds nothing rather
  // than an inherited Object.prototype member that a caller might mistake for a role list.
  const out = Object.create(null) as Record<string, readonly RoleKey[]>;
  for (const [orgId, set] of byOrg) out[orgId] = [...set].sort();
  return out;
}

/**
 * Maps a verified ZITADEL access token payload to our identity fields.
 *
 * All the ZITADEL claim names live here, in one function with fixtures, because they are the part
 * most likely to differ from the docs (plan risk R7).
 *
 * Roles are the union of the generic project roles claim and the claim scoped to `projectId`
 * (our API's project id, which is also `OIDC_AUDIENCE`). Claims scoped to any other project are
 * ignored on purpose: a token minted for another project must not grant roles here.
 *
 * `rolesByOrg` reads the same two claims but keeps the org each role was granted in. The P1
 * interceptor picks the list for the resolved org, so a Finance grant in another org does not
 * make the caller Finance here.
 */
export function mapClaims(payload: JWTPayload, projectId: string): MappedClaims {
  const { sub } = payload;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new InvalidClaimsError('token has no usable sub');
  }

  const org = payload[ORG_ID_CLAIM];
  const zitadelOrgId = typeof org === 'string' && org.length > 0 ? org : null;

  const roleClaims = [payload[PROJECT_ROLES_CLAIM], payload[projectRolesClaim(projectId)]];
  const roles = new Set(roleClaims.flatMap(roleKeys));

  return {
    userId: sub,
    zitadelOrgId,
    roles: [...roles].sort(),
    rolesByOrg: groupRolesByOrg(roleClaims),
  };
}
