// Messages for new controls also serve as fallbacks for other locales.
export const bosFallbackMessages = {
  error: {
    title: 'Sign-in error',
    tryAgainMessage: 'Something went wrong. Please try again.',
  },
  otp: {
    submitsWhenComplete: 'Submits automatically when all six digits are entered.',
    verified: 'Verified',
  },
};

// The provider returns its own default catalog as custom messages, even on a
// fresh instance. Apply only Business OS copy overrides after that catalog.
export const bosEnglishMessages = {
  loginname: {
    title: 'Sign in',
    labels: { loginname: 'Email or username', usernameOrEmail: 'Email or username' },
  },
  otp: {
    verify: {
      title: 'Two-step verification',
      totpDescription: 'Enter the six-digit code from your authenticator app.',
      labels: { code: 'Verification code' },
    },
    set: { labels: { code: 'Verification code' } },
  },
};
