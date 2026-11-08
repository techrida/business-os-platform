import { describe, expect, it } from 'vitest';

import { buildIssuer, IssuerIncompleteError, type IssuerSettings } from './issuer';

const scope = { tenantId: 't-1', organizationId: 'o-1' };
const address = { line1: 'Kupondole', city: 'Lalitpur', country: 'NP' };

function fakeSettings(values: Record<string, unknown>) {
  const asked: { scope: unknown; key: string }[] = [];
  const settings = {
    get: (s: unknown, key: string) => {
      asked.push({ scope: s, key });
      return Promise.resolve(values[key]);
    },
  } as unknown as IssuerSettings;
  return { settings, asked };
}

describe('buildIssuer', () => {
  it('joins the legal name with the entity settings, read for the entity scope', async () => {
    const { settings, asked } = fakeSettings({
      'entity.pan_vat_no': '301234567',
      'entity.address': address,
    });
    await expect(buildIssuer(settings, scope, 'Techrida Pvt. Ltd.')).resolves.toEqual({
      legalName: 'Techrida Pvt. Ltd.',
      panVatNo: '301234567',
      address,
    });
    expect(asked.map((a) => a.key).sort()).toEqual(['entity.address', 'entity.pan_vat_no']);
    expect(asked.every((a) => a.scope === scope)).toBe(true);
  });

  it('prints no number when none is set, and still builds the block', async () => {
    const { settings } = fakeSettings({ 'entity.pan_vat_no': null, 'entity.address': address });
    await expect(buildIssuer(settings, scope, 'Techrida')).resolves.toMatchObject({
      panVatNo: null,
    });
  });

  it.each([null, undefined, {}, { line1: 'x', city: 'y', country: 'Nepal' }])(
    'refuses with a typed error when the address is %j',
    async (bad) => {
      const { settings } = fakeSettings({ 'entity.pan_vat_no': null, 'entity.address': bad });
      const error = await buildIssuer(settings, scope, 'Techrida').catch((e: unknown) => e);
      expect(error).toBeInstanceOf(IssuerIncompleteError);
      expect(error).toMatchObject({ kind: 'issuer_incomplete', missing: 'address' });
    },
  );
});
