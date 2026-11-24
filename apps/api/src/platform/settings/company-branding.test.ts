// Unit test of brandingFromProfile (R6Q20): only the name and the primary logo leave the profile.
// Run: apps/api/node_modules/.bin/vitest run src/platform/settings/company-branding.test.ts (from apps/api)
import { EMPTY_COMPANY_PROFILE } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { brandingFromProfile } from './company-branding';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LOGO = '22222222-2222-4222-8222-222222222222';
const DARK = '33333333-3333-4333-8333-333333333333';

describe('brandingFromProfile', () => {
  it('names the tenant and the primary logo, and lets nothing else out', () => {
    const out = brandingFromProfile(TENANT, {
      ...EMPTY_COMPANY_PROFILE,
      displayName: '  Techrida  ',
      email: 'sales@example.com',
      website: 'example.com',
      logoDocumentId: LOGO,
      logoOnDarkDocumentId: DARK,
    });
    expect(out).toEqual({ displayName: 'Techrida', logo: { tenantId: TENANT, documentId: LOGO } });
  });

  it('is empty for no logo, a blank name, or a profile that does not validate', () => {
    expect(brandingFromProfile(TENANT, { ...EMPTY_COMPANY_PROFILE, displayName: '   ' })).toEqual({
      displayName: null,
      logo: null,
    });
    expect(brandingFromProfile(TENANT, { logoDocumentId: 'not-a-guid', extra: true })).toEqual({
      displayName: null,
      logo: null,
    });
    expect(brandingFromProfile(TENANT, undefined)).toEqual({ displayName: null, logo: null });
  });
});
