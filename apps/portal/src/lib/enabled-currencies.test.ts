import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import {
  currencyNotEnabledMessage,
  currencyNotEnabledText,
  currencyOptions,
  isCurrencyNotEnabled,
} from './enabled-currencies';
import { __resetEnvForTests } from './env';
import type { Session } from './session';

vi.mock('server-only', () => ({}));

const { submitVendorQuotation } = await import('./api.vendor-writes');

describe('currencyOptions', () => {
  it('offers only the enabled currencies, NPR first', () => {
    expect(currencyOptions(['NPR', 'USD'])).toEqual([
      { code: 'NPR', disabled: false },
      { code: 'USD', disabled: false },
    ]);
  });

  it('keeps NPR and the fixed order whatever the list says', () => {
    expect(currencyOptions(['USD', 'INR', 'USD']).map((o) => o.code)).toEqual([
      'NPR',
      'INR',
      'USD',
    ]);
    expect(currencyOptions([])).toEqual([{ code: 'NPR', disabled: false }]);
  });

  it('appends a switched-off selected currency as disabled', () => {
    expect(currencyOptions(['NPR', 'USD'], 'INR')).toEqual([
      { code: 'NPR', disabled: false },
      { code: 'USD', disabled: false },
      { code: 'INR', disabled: true },
    ]);
  });

  it('ignores a selected currency that is enabled, unknown or empty', () => {
    const plain = currencyOptions(['NPR', 'USD']);
    expect(currencyOptions(['NPR', 'USD'], 'USD')).toEqual(plain);
    expect(currencyOptions(['NPR', 'USD'], 'EUR')).toEqual(plain);
    expect(currencyOptions(['NPR', 'USD'], null)).toEqual(plain);
    expect(currencyOptions(['NPR', 'USD'], '')).toEqual(plain);
  });
});

/** The body the API's error filter sends for D44 (`currencyNotEnabled` in the API). */
const NOT_ENABLED = {
  error: {
    code: 'CURRENCY_NOT_ENABLED',
    message: 'Currency INR is not enabled for this company',
    correlationId: 'req-12345678',
    details: { currency: 'INR' },
  },
};
const SWITCHED_OFF = 'INR is switched off for the company. Choose another currency.';
const refusal = (status: number, body: unknown) =>
  new ApiError(status, `POST /v1/portal/vendor/quotation-submissions failed with ${status}`, body);

describe('isCurrencyNotEnabled', () => {
  it('is true for a 422 with the code', () => {
    expect(isCurrencyNotEnabled(refusal(422, NOT_ENABLED))).toBe(true);
  });

  it('is false for a 422 with another code, or the code on another status', () => {
    const other = { error: { code: 'validation_failed', message: 'Invalid' } };
    expect(isCurrencyNotEnabled(refusal(422, other))).toBe(false);
    expect(isCurrencyNotEnabled(refusal(400, NOT_ENABLED))).toBe(false);
    expect(isCurrencyNotEnabled(refusal(422, 'text'))).toBe(false);
    expect(isCurrencyNotEnabled(refusal(422, undefined))).toBe(false);
  });

  it('is false for anything that is not an ApiError', () => {
    expect(isCurrencyNotEnabled(new Error('offline'))).toBe(false);
    expect(isCurrencyNotEnabled(null)).toBe(false);
    expect(isCurrencyNotEnabled('CURRENCY_NOT_ENABLED')).toBe(false);
    expect(isCurrencyNotEnabled({ status: 422, body: NOT_ENABLED })).toBe(false);
  });
});

describe('currencyNotEnabledMessage', () => {
  it('names the currency', () => {
    expect(currencyNotEnabledMessage('INR')).toBe(SWITCHED_OFF);
  });
});

describe('currencyNotEnabledText', () => {
  it('names the currency from details', () => {
    expect(currencyNotEnabledText(refusal(422, NOT_ENABLED))).toBe(SWITCHED_OFF);
  });

  it('falls back to the code in the API message when details are missing or not a code', () => {
    const noDetails = { error: { ...NOT_ENABLED.error, details: undefined } };
    expect(currencyNotEnabledText(refusal(422, noDetails))).toBe(SWITCHED_OFF);
    const badDetails = { error: { ...NOT_ENABLED.error, details: { currency: '<b>' } } };
    expect(currencyNotEnabledText(refusal(422, badDetails))).toBe(SWITCHED_OFF);
  });

  it('says "This currency" when neither names a code, and never echoes other API text', () => {
    const bare = { error: { code: 'CURRENCY_NOT_ENABLED', message: 'Something <b>internal</b>' } };
    expect(currencyNotEnabledText(refusal(422, bare))).toBe(
      'This currency is switched off for the company. Choose another currency.',
    );
  });

  it('leaves every other failure alone', () => {
    const other = { error: { code: 'validation_failed', message: 'Invalid' } };
    expect(currencyNotEnabledText(refusal(422, other))).toBeUndefined();
    expect(currencyNotEnabledText(refusal(400, NOT_ENABLED))).toBeUndefined();
    expect(currencyNotEnabledText(new Error('offline'))).toBeUndefined();
    expect(currencyNotEnabledText(null)).toBeUndefined();
  });
});

describe('the API refusal as the vendor write path throws it', () => {
  const session: Session = {
    id: 'A'.repeat(43),
    sub: 'user-1',
    orgId: '00000000-0000-4000-8000-000000000002',
    orgKind: 'vendor',
    partyId: '00000000-0000-4000-8000-0000000000aa',
    roles: [],
    accessToken: 'eyJ.secret-access-token.sig',
    accessExp: 2_000_000_000,
    createdAt: 1_700_000_000,
    lastSeenAt: 1_700_000_000,
  };
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    for (const [k, v] of Object.entries({
      API_INTERNAL_URL: 'http://api:3001',
      OIDC_ISSUER: 'https://auth.test',
      OIDC_CLIENT_ID: 'client-123',
      OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
      OIDC_AUDIENCE: 'proj-42',
      PORTAL_PUBLIC_URL: 'https://app.test',
      VALKEY_URL: 'redis://valkey.test:6379',
      SESSION_ENC_KEY: Buffer.alloc(32, 5).toString('base64'),
    })) {
      vi.stubEnv(k, v);
    }
    __resetEnvForTests();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    __resetEnvForTests();
  });

  it('is recognised and worded from the 422 the API sends', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(NOT_ENABLED), { status: 422 }));
    const err = await submitVendorQuotation(
      session,
      {
        rfqId: '3d594650-3436-4a8f-b3a8-1c6a2f9d7e01',
        documentId: '0f8fad5b-d9cb-469f-a165-70867728950e',
        currency: 'INR',
        total: '1250000.50',
      },
      '3b241101-e2bb-4255-8caf-4136c566a962',
    ).catch((e: unknown) => e);

    expect(isCurrencyNotEnabled(err)).toBe(true);
    expect(currencyNotEnabledText(err)).toBe(SWITCHED_OFF);
  });
});
