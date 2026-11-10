import path from 'node:path';

import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';

// The monorepo root. Standalone output only copies files under this root, and pnpm keeps
// workspace packages (@bos/contracts) outside apps/workspace, so tracing must start higher up.
const monorepoRoot = path.join(__dirname, '../..');

// 'unsafe-inline' is needed because the App Router injects inline scripts (hydration data)
// and this app has no per-request nonce yet. 'unsafe-eval' is only for React's dev tooling.
// No form-action directive: Chrome applies it to the redirect after a form POST, so it would
// block "Sign out" when /auth/logout answers with a redirect to the identity provider.
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: monorepoRoot,
  // Turbopack (the default bundler) has its own root setting. Keep it equal to the tracing
  // root so Next does not warn about two different roots.
  turbopack: { root: monorepoRoot },
  poweredByHeader: false,

  // Dev-only page extensions let `*.dev.tsx` files (the persona switcher) exist in development.
  // The docs only describe pageExtensions for the Pages Router, so this switch may have no
  // effect on the App Router in Next 16. Do not rely on it: the real protection is the
  // `notFound()` guard in the dev page (wall 2) and the post-build checker (wall 3).
  pageExtensions: isDev ? ['dev.tsx', 'dev.ts', 'tsx', 'ts'] : ['tsx', 'ts'],

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
