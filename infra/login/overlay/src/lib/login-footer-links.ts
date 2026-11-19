import 'server-only';

function webUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;

  try {
    const url = new URL(value);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch {
    // A malformed deployment URL should not break sign-in.
  }
}

export function loginFooterLinks() {
  return {
    helpHref: webUrl(process.env.LOGIN_HELP_URL),
    privacyHref: webUrl(process.env.LOGIN_PRIVACY_URL),
  };
}
