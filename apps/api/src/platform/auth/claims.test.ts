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
    expect(mapped).toEqual({
      userId: 'user-1',
      zitadelOrgId: 'org-1',
      roles: [],
      rolesByOrg: {},
    });
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

describe('mapClaims rolesByOrg', () => {
  const ORG_A = '290000000000000001';
  const ORG_B = '290000000000000002';
  const inA = { [ORG_A]: 'staff.auth.localhost' };
  const inB = { [ORG_B]: 'other.auth.localhost' };
  const inBoth = { ...inA, ...inB };
  const SCOPED = projectRolesClaim(PROJECT);

  it('leaves out of org A a role granted only in org B', () => {
    const mapped = mapClaims(
      { sub: 'u', [ORG_ID_CLAIM]: ORG_A, [SCOPED]: { sales: inA, finance: inB } },
      PROJECT,
    );
    expect(mapped.rolesByOrg[ORG_A]).toEqual(['sales']);
    expect(mapped.rolesByOrg[ORG_B]).toEqual(['finance']);
    // The P0 flat list still unions every org; the interceptor must use rolesByOrg instead.
    expect(mapped.roles).toEqual(['finance', 'sales']);
  });

  it('has no entry for an org where nothing was granted', () => {
    const mapped = mapClaims(
      { sub: 'u', [ORG_ID_CLAIM]: ORG_A, [SCOPED]: { founder: inB } },
      PROJECT,
    );
    expect(mapped.rolesByOrg[ORG_A]).toBeUndefined();
    expect(Object.keys(mapped.rolesByOrg)).toEqual([ORG_B]);
  });

  it('lists a role granted in two orgs under both', () => {
    const mapped = mapClaims(
      { sub: 'u', [ORG_ID_CLAIM]: ORG_A, [SCOPED]: { management: inBoth } },
      PROJECT,
    );
    expect(mapped.rolesByOrg).toEqual({ [ORG_A]: ['management'], [ORG_B]: ['management'] });
  });

  it('drops role keys that are not in ROLE_KEYS', () => {
    const mapped = mapClaims(
      { sub: 'u', [ORG_ID_CLAIM]: ORG_A, [SCOPED]: { admin: inA, sales: inA } },
      PROJECT,
    );
    expect(mapped.rolesByOrg).toEqual({ [ORG_A]: ['sales'] });
  });

  it('groups the scoped claim per org, sorted', () => {
    const mapped = mapClaims(
      {
        sub: 'u',
        [ORG_ID_CLAIM]: ORG_A,
        [SCOPED]: { sales: inA, finance: inA, accountant: inB },
      },
      PROJECT,
    );
    expect(mapped.rolesByOrg).toEqual({ [ORG_A]: ['finance', 'sales'], [ORG_B]: ['accountant'] });
  });

  // R3: the generic claim does not name a project, so a role in it may belong to another project
  // in the same ZITADEL instance. Only the claim scoped to our project id may grant roles here.
  it('grants nothing from the generic project roles claim', () => {
    const mapped = mapClaims(
      { sub: 'u', [ORG_ID_CLAIM]: ORG_A, [PROJECT_ROLES_CLAIM]: { founder: inA } },
      PROJECT,
    );
    expect(mapped.rolesByOrg).toEqual({});
  });

  it('ignores the generic claim even next to the scoped one', () => {
    const mapped = mapClaims(
      {
        sub: 'u',
        [ORG_ID_CLAIM]: ORG_A,
        [PROJECT_ROLES_CLAIM]: { founder: inA, finance: inA },
        [SCOPED]: { sales: inA },
      },
      PROJECT,
    );
    expect(mapped.rolesByOrg).toEqual({ [ORG_A]: ['sales'] });
  });

  it("ignores roles scoped to another project's id", () => {
    const mapped = mapClaims(
      { sub: 'u', [ORG_ID_CLAIM]: ORG_A, [projectRolesClaim(OTHER_PROJECT)]: { founder: inA } },
      PROJECT,
    );
    expect(mapped.rolesByOrg).toEqual({});
  });

  it.each([
    ['an array', [ORG_A]],
    ['a string', ORG_A],
    ['null', null],
  ])('ignores a role whose org value is %s', (_label, value) => {
    const mapped = mapClaims(
      { sub: 'u', [ORG_ID_CLAIM]: ORG_A, [SCOPED]: { founder: value } },
      PROJECT,
    );
    expect(mapped.rolesByOrg).toEqual({});
  });

  it('finds no inherited object members when an org id is looked up', () => {
    const mapped = mapClaims({ sub: 'u', [ORG_ID_CLAIM]: ORG_A }, PROJECT);
    expect(mapped.rolesByOrg['constructor']).toBeUndefined();
    expect(mapped.rolesByOrg['toString']).toBeUndefined();
  });
});
