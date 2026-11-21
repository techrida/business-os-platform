// One switch for the dev-only layer (DEV MENU, /dev/personas, dev account switch, cookie namespace).
//
// It is on under `next dev` (NODE_ENV=development) and in a build made with
// BOS_BUILD_PROFILE=dev (the "dev build": compiled like production, dev tools included).
// next.config.ts copies the profile into BOS_DEV_TOOLS at build time, and Next inlines it, so a
// production build holds a literal '0' here and an environment variable set at run time cannot
// turn the tools on.
export function devToolsEnabled(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.BOS_DEV_TOOLS === '1';
}
