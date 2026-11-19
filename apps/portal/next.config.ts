import path from 'node:path';

import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';

// The monorepo root. Standalone output only copies files under this root, and pnpm keeps
// workspace packages (@bos/contracts) outside apps/portal, so tracing must start higher up.
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
  // The PDF viewer's pdf.js worker is a bundled same-origin asset. No blob: and no CDN.
  "worker-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

// The document viewer frames the PDF preview routes from the app's own pages, so those paths (and
// only those) are framable by the same origin. Same policy otherwise: derived, not copied.
const framableContentSecurityPolicy = [
  ...contentSecurityPolicy.split('; ').filter((d) => !d.startsWith('frame-ancestors')),
  "frame-ancestors 'self'",
].join('; ');
const previewPaths = [
  '/quotations/:id/document/preview',
  '/invoices/:id/document/preview',
  '/vendor/purchase-orders/:id/pdf/preview',
];

const nextConfig: NextConfig = {
  output: 'standalone',
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
      // Later rules win for the same key, so these override the framing headers above.
      ...previewPaths.map((source) => ({
        source,
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: framableContentSecurityPolicy },
        ],
      })),
    ]);
  },
};

export default nextConfig;
