import { describe, expect, it } from 'vitest';

import { companyLogo } from './company-logo';

const ID = '11111111-1111-4111-8111-111111111111';
const LOGO = '77777777-7777-4777-8777-777777777777';

describe('companyLogo', () => {
  it('maps a company to its logo, its name and the id the initials colour is seeded from', () => {
    expect(companyLogo({ id: ID, legalName: 'Himal Traders', logoDocumentId: LOGO })).toEqual({
      name: 'Himal Traders',
      seedId: ID,
      imageDocumentId: LOGO,
      shape: 'square',
      fit: 'contain',
    });
  });

  it('gives initials for a missing or cleared logo', () => {
    expect(companyLogo({ id: ID, legalName: 'Himal Traders' }).imageDocumentId).toBeNull();
    expect(
      companyLogo({ id: ID, legalName: 'Himal Traders', logoDocumentId: null }).imageDocumentId,
    ).toBeNull();
  });
});
