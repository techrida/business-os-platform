import { describe, expect, it } from 'vitest';

import {
  InvalidClaimsError,
  mapClaims,
  ORG_ID_CLAIM,
  PROJECT_ROLES_CLAIM,
  projectRolesClaim,
} from './claims';

const PROJECT = '300000000000000001';
const OTHER_PROJECT = '300000000000000999';

// Shape from the ZITADEL claims docs: role key -> { orgId: orgPrimaryDomain }.
const grant = { '290000000000000001': 'staff.auth.localhost' };

describe('mapClaims', () => {
  it('maps sub and the resourceowner org id', () => {
    const mapped = mapClaims({ sub: 'user-1', [ORG_ID_CLAIM]: 'org-1' }, PROJECT);
    expect(mapped).toEqual({ userId: 'user-1', zitadelOrgId: 'org-1', roles: [] });
  });

  it('reads roles from the generic project roles claim', () => {
    const mapped = mapClaims(
      { sub: 'u', [ORG_ID_CLAIM]: 'o', [PROJECT_ROLES_CLAIM]: { admin: grant, viewer: grant } },
      PROJECT,
    );
    expect(mapped.roles).toEqual(['admin', 'viewer']);
  });

  it('reads roles from the claim scoped to our project id', () => {
    const mapped = mapClaims(
      { sub: 'u', [ORG_ID_CLAIM]: 'o', [projectRolesClaim(PROJECT)]: { editor: grant } },
      PROJECT,
    );
    expect(mapped.roles).toEqual(['editor']);
  });

  it('unions both claim forms, sorted and de-duplicated', () => {
    const mapped = mapClaims(
      {
        sub: 'u',
        [ORG_ID_CLAIM]: 'o',
        [PROJECT_ROLES_CLAIM]: { viewer: grant, admin: grant },
        [projectRolesClaim(PROJECT)]: { admin: grant, editor: grant },
      },
      PROJECT,
    );
    expect(mapped.roles).toEqual(['admin', 'editor', 'viewer']);
  });

  it("ignores roles scoped to another project's id", () => {
    const mapped = mapClaims(
      {
        sub: 'u',
        [ORG_ID_CLAIM]: 'o',
        [projectRolesClaim(OTHER_PROJECT)]: { superuser: grant },
        [projectRolesClaim(PROJECT)]: { viewer: grant },
      },
      PROJECT,
    );
    expect(mapped.roles).toEqual(['viewer']);
  });

  it.each([
    ['an array', ['admin']],
    ['a string', 'admin'],
    ['null', null],
    ['a number', 1],
  ])('ignores a roles claim that is %s', (_label, value) => {
    const mapped = mapClaims(
      { sub: 'u', [ORG_ID_CLAIM]: 'o', [PROJECT_ROLES_CLAIM]: value },
      PROJECT,
    );
    expect(mapped.roles).toEqual([]);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', 42],
  ])('returns a null org when the org claim is %s', (_label, value) => {
    const mapped = mapClaims({ sub: 'u', [ORG_ID_CLAIM]: value }, PROJECT);
    expect(mapped.zitadelOrgId).toBeNull();
  });

  it('throws when sub is missing', () => {
    expect(() => mapClaims({ [ORG_ID_CLAIM]: 'o' }, PROJECT)).toThrow(InvalidClaimsError);
  });

  it('throws when sub is empty', () => {
    expect(() => mapClaims({ sub: '', [ORG_ID_CLAIM]: 'o' }, PROJECT)).toThrow(InvalidClaimsError);
  });
});
