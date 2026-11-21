import path from 'node:path';

import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';

// Build profile. `production` (default) is what ships. `dev` is a compiled build, run like production,
// that still carries the dev layer (DEV MENU, /dev/personas): for testing the real app on a dev host.
// It is chosen when the build is made, never at run time. See docs/platform/runbook-build-profiles.md.
const buildProfile = process.env.BOS_BUILD_PROFILE ?? 'production';
if (buildProfile !== 'dev' && buildProfile !== 'production') {
  throw new Error(`BOS_BUILD_PROFILE must be "dev" or "production", got "${buildProfile}"`);
}
const devBuild = buildProfile === 'dev';
const devTools = isDev || devBuild;

// The monorepo root. Standalone output only copies files under this root, and pnpm keeps
// workspace packages (@bos/contracts) outside apps/workspace, so tracing must start higher up.
const monorepoRoot = path.join(__dirname, '../..');

// 'unsafe-inline' is needed because the App Router injects inline scripts (hydration data)
// and this app has no per-request nonce yet. 'unsafe-eval' is only for React's dev tooling.
// No form-action directive: Chrome applies it to the redirect after a form POST, so it would
// block "Sign out" when /auth/logout answers with a redirect to the identity provider.
const contentSecurityDirectives = [
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
];
const contentSecurityPolicy = [...contentSecurityDirectives, "frame-ancestors 'none'"].join('; ');
const filePreviewPolicy = [...contentSecurityDirectives, "frame-ancestors 'self'"].join('; ');

const nextConfig: NextConfig = {
  // The HTTPS proxy's configured host must also be allowed for the dev websocket.
  // Otherwise Next retries the blocked connection and eventually reloads the page.
  ...(isDev && process.env.WORKSPACE_PUBLIC_URL
    ? { allowedDevOrigins: [new URL(process.env.WORKSPACE_PUBLIC_URL).hostname] }
    : {}),
  // Inlined into server and client bundles at build time. A production-profile build gets '0'.
  env: { BOS_DEV_TOOLS: devBuild ? '1' : '0' },
  // The dev build has its own output folder, so it never overwrites (or is checked as) the production build.
  distDir: devBuild ? '.next-devtools' : '.next',
  output: 'standalone',
  outputFileTracingRoot: monorepoRoot,
  // Turbopack (the default bundler) has its own root setting. Keep it equal to the tracing
  // root so Next does not warn about two different roots.
  turbopack: { root: monorepoRoot },
  poweredByHeader: false,

  // The production build type-checks the app without its test files. A test may import a file from another
  // workspace package (the API's pure rules) that the filtered install of the image has no node_modules for.
  // `pnpm typecheck` still checks every test with the full tsconfig.json.
  typescript: { tsconfigPath: 'tsconfig.build.json' },

  // @bos/pdf-viewer ships TypeScript source and a CSS file (no dist build), so Next compiles it.
  transpilePackages: ['@bos/pdf-viewer'],

  // The memo PDF (src/lib/memo-pdf.ts) uses pdfkit, which reads its own data files at runtime, so it stays an
  // external package instead of being bundled. The fonts it embeds are read from assets/fonts at request time,
  // so the standalone trace is told to carry them into the image.
  serverExternalPackages: ['pdfkit'],
  outputFileTracingIncludes: {
    '/api/memos/pdf': ['./assets/fonts/**/*'],
    '/api/memos/[id]/pdf': ['./assets/fonts/**/*'],
  },

  // Dev-only page extensions let `*.dev.tsx` files (the persona switcher) exist in development and in the dev build.
  // The docs only describe pageExtensions for the Pages Router, so this switch may have no
  // effect on the App Router in Next 16. Do not rely on it: the real protection is the
  // `notFound()` guard in the dev page (wall 2) and the post-build checker (wall 3).
  pageExtensions: devTools ? ['dev.tsx', 'dev.ts', 'tsx', 'ts'] : ['tsx', 'ts'],

  // Roles and permissions became Settings > Access (By role tab), and Organisation/Department
  // routes moved under Settings. Temporary (307), so browsers do not cache them for good.
  redirects() {
    return Promise.resolve([
      { source: '/settings/roles', destination: '/settings/access/roles', permanent: false },
      { source: '/settings/organization', destination: '/settings/organisation', permanent: false },
      { source: '/organisation', destination: '/settings/organisation', permanent: false },
      { source: '/organization', destination: '/settings/organisation', permanent: false },
      {
        source: '/organisation/departments',
        destination: '/settings/departments',
        permanent: false,
      },
      {
        source: '/organisation/departments/:path*',
        destination: '/settings/departments/:path*',
        permanent: false,
      },
      {
        source: '/organization/departments',
        destination: '/settings/departments',
        permanent: false,
      },
      {
        source: '/organization/departments/:path*',
        destination: '/settings/departments/:path*',
        permanent: false,
      },
      {
        source: '/organisation/department',
        destination: '/settings/departments',
        permanent: false,
      },
      {
        source: '/organization/department',
        destination: '/settings/departments',
        permanent: false,
      },
      { source: '/organisation/users', destination: '/settings/users', permanent: false },
      {
        source: '/organisation/users/:path*',
        destination: '/settings/users/:path*',
        permanent: false,
      },
      { source: '/organization/users', destination: '/settings/users', permanent: false },
      {
        source: '/organization/users/:path*',
        destination: '/settings/users/:path*',
        permanent: false,
      },
      { source: '/organisation/access', destination: '/settings/access', permanent: false },
      {
        source: '/organisation/access/:path*',
        destination: '/settings/access/:path*',
        permanent: false,
      },
      { source: '/organization/access', destination: '/settings/access', permanent: false },
      {
        source: '/organization/access/:path*',
        destination: '/settings/access/:path*',
        permanent: false,
      },
      { source: '/organisation/roles', destination: '/settings/access/roles', permanent: false },
      { source: '/organization/roles', destination: '/settings/access/roles', permanent: false },
      { source: '/organisation/workflows', destination: '/settings/workflows', permanent: false },
      { source: '/organization/workflows', destination: '/settings/workflows', permanent: false },
      { source: '/department', destination: '/settings/departments', permanent: false },
      { source: '/departments', destination: '/settings/departments', permanent: false },
      {
        source: '/departments/:path*',
        destination: '/settings/departments/:path*',
        permanent: false,
      },
    ]);
  },

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
      {
        // This route streams only authenticated, scan-approved PDF or raster image bytes.
        source: '/api/documents/:documentId/versions/:versionId/preview',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: filePreviewPolicy },
        ],
      },
      {
        // Invoice previews stream only the authenticated, scan-approved original PDF.
        source: '/invoices/:id/document/preview',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: filePreviewPolicy },
        ],
      },
    ]);
  },
};

export default nextConfig;
