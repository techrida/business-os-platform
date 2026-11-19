import { expect, it } from 'vitest';

import { getFooterLinks } from './env';

it('returns the configured http(s) URLs', () => {
  expect(
    getFooterLinks({
      BOS_HELP_URL: 'https://help.example.com/bos',
      BOS_PRIVACY_URL: ' http://example.com/privacy ',
    }),
  ).toEqual({ helpUrl: 'https://help.example.com/bos', privacyUrl: 'http://example.com/privacy' });
});

it('treats unset, blank and invalid values as unset, without throwing', () => {
  expect(getFooterLinks({})).toEqual({ helpUrl: undefined, privacyUrl: undefined });
  expect(getFooterLinks({ BOS_HELP_URL: '', BOS_PRIVACY_URL: '   ' })).toEqual({
    helpUrl: undefined,
    privacyUrl: undefined,
  });
  expect(
    getFooterLinks({ BOS_HELP_URL: 'javascript:alert(1)', BOS_PRIVACY_URL: '/privacy' }),
  ).toEqual({ helpUrl: undefined, privacyUrl: undefined });
});

it('reads process.env by default', () => {
  process.env.BOS_HELP_URL = 'https://help.example.com';
  try {
    expect(getFooterLinks().helpUrl).toBe('https://help.example.com');
  } finally {
    delete process.env.BOS_HELP_URL;
  }
});
