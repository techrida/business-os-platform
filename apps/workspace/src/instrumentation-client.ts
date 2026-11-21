// Dev-only tooling. Next.js inlines process.env.NODE_ENV and BOS_DEV_TOOLS (next.config.ts `env`) at
// build time, so in a production-profile build this condition is statically false and the bundler drops the branch together with the
// dynamic import. The dev menu is then absent from every emitted file.
if (process.env.NODE_ENV === 'development' || process.env.BOS_DEV_TOOLS === '1') {
  void import('./dev/dev-menu');
}
