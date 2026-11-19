// Messages for new controls also serve as fallbacks for other locales.
export const bosFallbackMessages = {
  error: {
    title: 'Sign-in error',
    tryAgainMessage: 'Something went wrong. Please try again.',
  },
  bosAuth: {
    showPassword: 'Show password',
    hidePassword: 'Hide password',
    // B2
    copy: 'Copy setup link',
    copied: 'Copied',
  },
  otp: {
    submitsWhenComplete: 'Submits automatically when all six digits are entered.',
    verified: 'Verified',
  },
  loginname: {
    placeholders: { loginname: 'you@company.com' },
    noAccount: "Don't have an account?",
  },
  register: {
    placeholders: {
      firstname: 'Enter your first name',
      lastname: 'Enter your last name',
      email: 'you@company.com',
    },
    haveAccount: 'Already have an account?',
    signIn: 'Sign in',
  },
  password: {
    set: {
      resetRequested: 'Check your email',
      resetTitle: 'Set a new password',
      emailInstructions:
        'If the account can be reset, you’ll receive an email with a link to choose a new password.',
      descriptionCode: 'Choose and confirm your new password.',
    },
  },
  pending: {
    title: 'Account pending verification',
    chip: 'Pending verification',
    heading: 'Your account is awaiting verification',
    lead: "Once an admin verifies your account, we'll notify you by email.",
    submitted: 'Your sign-up request has been submitted.',
    watchMail: 'Keep an eye on your work email. No further action is needed right now.',
    back: 'Back to sign in',
    caption: 'You can sign in once your account is verified.',
  },
};

// The provider returns its own default catalog as custom messages, even on a
// fresh instance. Apply only Business OS copy overrides after that catalog.
export const bosEnglishMessages = {
  loginname: {
    title: 'Welcome to Business OS',
    description: 'Create your Northstar workspace and make work feel a little more human.',
    // Shown as the link in "Don't have an account? Sign up".
    register: 'Sign up',
    // e2e selects this field by its "Email or username" label, so Figma's "Work email" is not used.
    labels: { loginname: 'Email or username', usernameOrEmail: 'Email or username' },
  },
  password: {
    verify: {
      title: 'Welcome to Business OS',
      resetPassword: 'Forgot password?',
    },
    set: {
      title: 'Create New Password',
      submit: 'Verify and Continue',
    },
  },
  register: {
    title: 'Sign Up to Business OS',
    description: 'Create your Business OS account and make work feel a little more human.',
    labels: { email: 'Work email' },
    password: { labels: { password: 'Create a password' } },
  },
  otp: {
    verify: {
      // B2: Figma "Two-Step Verification" wording. The page knows the login name only, never the delivery
      // address, so the email and SMS leads do not name it.
      title: 'Two-Step Verification',
      submit: 'Verify and Continue',
      totpDescription: 'Enter the six-digit code from your authenticator app.',
      emailDescription:
        'We sent a verification code to your email address. Enter the code below to confirm your identity.',
      smsDescription:
        'We sent a verification code by text message. Enter the code below to confirm your identity.',
      labels: { code: 'Verification code' },
    },
    set: { labels: { code: 'Verification code' } },
  },
};
