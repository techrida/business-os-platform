import path from 'node:path';

import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';

// The monorepo root. Standalone output only copies files under this root, and pnpm keeps
// workspace packages (@bos/contracts) outside apps/portal, so tracing must start higher up.
const monorepoRoot = path.join(__dirname, '../..');

// 'unsafe-inline' is needed because the App Router injects inline scripts (hydration data)
// and this app has no per-request nonce yet. 'unsafe-eval' is only for React's dev tooling.
// Form posts may only go to this app and to the identity provider. Chrome applies form-action to the redirect that
// follows a form POST, so "Sign out" (POST /auth/logout, answered with a redirect to the issuer's end_session) needs
// the issuer origin in the list. headers() is resolved at build time: a build that has OIDC_ISSUER set (compose.yaml
// gives it to the app containers at run time only) names the exact origin; a build without it allows any https:
// origin, which still blocks forms that post to http:, data: or javascript: targets.
const issuerOrigin = (() => {
  try {
    return new URL(process.env.OIDC_ISSUER ?? '').origin;
  } catch {
    return 'https:';
  }
})();
const formAction = `form-action 'self' ${issuerOrigin}`;
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  // The PDF viewer's pdf.js worker is a bundled same-origin asset. No blob: and no CDN.
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  formAction,
  "frame-ancestors 'none'",
].join('; ');

// Bake the namespace into development builds. All cookie reads and writes must use the
// same names even if the service environment changes between build and start.
const cookieNamespace =
  isDev || process.env.BOS_BUILD_PROFILE === 'dev'
    ? process.env.BOS_DEV_COOKIE_NAMESPACE
    : undefined;
if (cookieNamespace !== undefined && !/^[a-z][a-z0-9-]{0,31}$/.test(cookieNamespace)) {
  throw new Error('Invalid BOS_DEV_COOKIE_NAMESPACE');
}

const nextConfig: NextConfig = {
  env: {
    BOS_PORTAL_COOKIE_PREFIX: cookieNamespace
      ? `__Host-bos_${cookieNamespace}_portal`
      : '__Host-bos_portal',
  },
  output: 'standalone',
  // Show images as they are: nothing resizes them on the server, so the image library (sharp) stays out of the build.
  images: { unoptimized: true },
  outputFileTracingRoot: monorepoRoot,
  // Turbopack (the default bundler) has its own root setting. Keep it equal to the tracing
  // root so Next does not warn about two different roots.
  turbopack: { root: monorepoRoot },
  poweredByHeader: false,

  // @bos/pdf-viewer ships TypeScript source and a CSS file (no dist build), so Next compiles it.
  transpilePackages: ['@bos/pdf-viewer'],

  // `next build` type-checks only the app. The full tsconfig.json also covers e2e/ and the
  // test configs; the e2e specs import apps/workspace/e2e helpers, whose dependencies the
  // filtered Docker install does not provide. `pnpm typecheck` still uses tsconfig.json.
  typescript: { tsconfigPath: 'tsconfig.build.json' },

  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Content-Security-Policy', value: contentSecurityPolicy },
        ],
      },
    ]);
  },
};

export default nextConfig;
