// Dev-only tooling. Next.js inlines process.env.NODE_ENV at build time, so in a production
// build this condition is statically false and the bundler drops the branch together with the
// dynamic import. The dev menu is then absent from every emitted file.
if (process.env.NODE_ENV === 'development') {
  void import('./dev/dev-menu');
}
