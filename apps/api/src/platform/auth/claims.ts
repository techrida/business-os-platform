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
  /** Token expiry, seconds since the epoch (`exp`). */
  readonly tokenExp: number;
}

/** An Express request after the AuthGuard ran. `auth` is unset on public routes. */
export type AuthenticatedRequest = Request & { auth?: AuthIdentity };

export interface MappedClaims {
  readonly userId: string;
  /** `null` when the token carries no usable org claim; the guard answers that with 403. */
  readonly zitadelOrgId: string | null;
  readonly roles: readonly string[];
}

/** Thrown when a verified token still lacks a usable `sub`. The guard maps it to 401. */
export class InvalidClaimsError extends Error {
  override readonly name = 'InvalidClaimsError';
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const roleKeys = (claim: unknown): string[] => (isPlainObject(claim) ? Object.keys(claim) : []);

/**
 * Maps a verified ZITADEL access token payload to our identity fields.
 *
 * All the ZITADEL claim names live here, in one function with fixtures, because they are the part
 * most likely to differ from the docs (plan risk R7).
 *
 * Roles are the union of the generic project roles claim and the claim scoped to `projectId`
 * (our API's project id, which is also `OIDC_AUDIENCE`). Claims scoped to any other project are
 * ignored on purpose: a token minted for another project must not grant roles here.
 */
export function mapClaims(payload: JWTPayload, projectId: string): MappedClaims {
  const { sub } = payload;
  if (typeof sub !== 'string' || sub.length === 0) {
    throw new InvalidClaimsError('token has no usable sub');
  }

  const org = payload[ORG_ID_CLAIM];
  const zitadelOrgId = typeof org === 'string' && org.length > 0 ? org : null;

  const roles = new Set([
    ...roleKeys(payload[PROJECT_ROLES_CLAIM]),
    ...roleKeys(payload[projectRolesClaim(projectId)]),
  ]);

  return { userId: sub, zitadelOrgId, roles: [...roles].sort() };
}
