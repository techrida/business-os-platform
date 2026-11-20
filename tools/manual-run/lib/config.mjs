// Configuration from the environment and the command line. Every value has one source of truth
// here; workflows read `cfg` and never `process.env` directly.
import { existsSync } from 'node:fs';
import path from 'node:path';

const env = process.env;

export const WORKFLOWS = ['start', 'sales', 'procurement', 'branches'];

/**
 * `1440x900` → { width: 1440, height: 900, text: '1440x900' }. Leading zeros are refused, so one
 * viewport has exactly one spelling, one output folder and one run key.
 */
export function parseViewport(text) {
  const m = /^([1-9]\d{2,3})x([1-9]\d{2,3})$/.exec(String(text ?? '').trim());
  if (!m) throw new Error(`Viewport must look like 1440x900 (no leading zeros), got "${text}"`);
  const width = Number(m[1]);
  const height = Number(m[2]);
  return { width, height, text: `${width}x${height}` };
}

/**
 * The workspace navigation a viewport width gets, from the shell's media queries
 * (apps/workspace/src/components/shell/shell.module.css): 1024 px and wider has the Collapse sidebar
 * toggle, 768–1023 px a fixed icon rail with no toggle, narrower an Open menu drawer.
 * @returns {'sidebar' | 'rail' | 'drawer'}
 */
export function navLayout(width) {
  if (width >= 1024) return 'sidebar';
  if (width >= 768) return 'rail';
  return 'drawer';
}

/** `--name value` and `--name=value`; bare `--flag` becomes true. */
export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const eq = a.indexOf('=');
    if (eq > 0) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--'))
      out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

/** Hosts of a development stack on this machine or the local *.bos.test workspaces. */
export function isLocalHost(hostname) {
  const h = String(hostname).toLowerCase();
  return (
    h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h.endsWith('.bos.test')
  );
}

/**
 * Every origin the driver talks to must be https (TLS is always verified against the stack CA)
 * and, unless ALLOW_NON_LOCAL_TARGET=1, a local development host. The driver creates and approves
 * records with real accounts; it must never be pointed at a shared or production stack by accident.
 * Returns the normalised origin (no trailing slash).
 */
export function checkOrigin(name, value, { allowNonLocal = false } = {}) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    // Not quoted: a value that does not parse may still hold a user name and password.
    throw new Error(`${name} is not a URL.`);
  }
  if (u.protocol !== 'https:')
    throw new Error(
      `${name} must use https:// (got ${u.protocol}//${u.host}); TLS is always verified.`,
    );
  if (u.username || u.password)
    throw new Error(`${name} must not contain a user name or password.`);
  if (u.pathname !== '/' || u.search || u.hash)
    throw new Error(`${name} must be an origin only, like https://app.testrun.localhost:58343`);
  if (!allowNonLocal && !isLocalHost(u.hostname))
    throw new Error(
      `${name} host ${u.hostname} is not a local development host (localhost, *.localhost, ` +
        '127.0.0.1 or *.bos.test). Set ALLOW_NON_LOCAL_TARGET=1 only if you mean to drive that stack.',
    );
  return u.origin;
}

/**
 * Run labels are case-insensitive and lower-cased here: the app matches names case-insensitively,
 * so SCR1 and scr1 would otherwise find each other's records. No dashes: `-` separates the label
 * from the viewport in the run key (see runKeyFor).
 */
export function normaliseLabel(raw) {
  const label = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9]{1,24}$/.test(label))
    throw new Error(
      `Set a run label: --label scr1 or RUN_LABEL=scr1 (letters and digits only, max 24; got ${JSON.stringify(raw ?? '')}).`,
    );
  return label;
}

export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const pad4 = (n) => String(n).padStart(4, '0');

/**
 * `<label>-<width>x<height>`, each as 4 digits: `scr1-1440x0900`, `scr1-0390x0844`. The label holds
 * no dash and both sizes always have four digits, so one run key is never the start of another,
 * two viewports never share one, and a name carrying it can be found as plain text even where a
 * table row runs the next cell straight on after it (`…SCR-scr1-1440x0900Dev Sales`).
 */
export const runKeyFor = (label, width, height) => `${label}-${pad4(width)}x${pad4(height)}`;

/**
 * The run key of output folders from before 20 Nov 2026 (width only, `scr1-1440`). A resumed
 * folder whose state.json stores no run key keeps using it, so its records are still found.
 */
export const legacyRunKeyFor = (label, width) => `${label}-${pad4(width)}`;

/** This run's unique text (a name carrying the run key, a record number): literal and case-sensitive. */
export const runMatch = (text) => new RegExp(escapeRe(text));

const bool = (v, dflt) =>
  v === undefined || v === '' ? dflt : !/^(0|false|no|off)$/i.test(String(v));

// Playwright's debug output (DEBUG=pw:api, PWDEBUG, DEBUG_FILE …) prints the raw values passed to
// fill and pressSequentially, which include the seeded passwords and one-time codes.
const DEBUG_ENV =
  /^(DEBUG|DEBUG_FILE|PWDEBUG|PWDEBUGIMPL|PW_DEBUG_[A-Z_]*|(PW|PLAYWRIGHT)_[A-Z_]*(DEBUG|LOG|TRACE)[A-Z_]*)$/;

/**
 * Refuses a DEBUG value that turns on Playwright's logs (a `pw…` or `*…` pattern), then removes every
 * debug variable from `e` (process.env by default, which the browser and its launcher inherit).
 * Returns the names removed. Runs before Playwright is loaded.
 */
export function scrubDebugEnv(e = process.env) {
  const patterns = String(e.DEBUG ?? '').split(/[\s,]+/);
  if (patterns.some((p) => p.startsWith('pw') || p.startsWith('*')))
    throw new Error(
      'DEBUG turns on Playwright logging, which prints the typed passwords and one-time codes. ' +
        'Unset DEBUG to run the manual-run driver.',
    );
  const removed = Object.keys(e).filter((k) => DEBUG_ENV.test(k));
  for (const k of removed) delete e[k];
  return removed;
}

export function loadConfig(args = {}) {
  // Node would then accept any certificate for the Mailpit API and the TLS checks.
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0')
    throw new Error(
      'NODE_TLS_REJECT_UNAUTHORIZED=0 turns off certificate checks; unset it. The driver verifies ' +
        "TLS against the stack's CA itself.",
    );
  const label = normaliseLabel(args.label ?? env.RUN_LABEL);
  const { text: viewportText, ...viewport } = parseViewport(
    args.viewport ?? env.VIEWPORT ?? '1440x900',
  );
  const personasFile = env.PERSONAS_FILE;
  if (!personasFile)
    throw new Error(
      "Set PERSONAS_FILE to the stack's .dev/personas.json (read-only; never printed).",
    );
  // Only the stack's own CA: never a general bundle such as NODE_EXTRA_CA_CERTS, which may hold
  // every public root and would make any public site look like the stack.
  const caFile = env.CA_FILE || path.join(path.dirname(personasFile), 'caddy-root.crt');
  if (!existsSync(caFile))
    throw new Error(
      `CA file ${caFile} not found. Set CA_FILE to the stack's local root certificate ` +
        "(the personas folder's caddy-root.crt).",
    );
  const allowNonLocal = env.ALLOW_NON_LOCAL_TARGET === '1';
  const origin = (name, value) => checkOrigin(name, value, { allowNonLocal });
  const appUrl = origin('APP_URL', env.APP_URL || 'https://app.testrun.localhost:58343');
  const videoRoot = env.VIDEO_DIR || '/home/crestia/bos-runtimes/manual-run';
  const outDir = path.join(videoRoot, label, viewportText);
  return {
    appUrl,
    portalUrl: origin('PORTAL_URL', env.PORTAL_URL || 'https://portal.testrun.localhost:58343'),
    mailUrl: origin('MAIL_URL', env.MAIL_URL || 'https://mail.testrun.localhost:58343'),
    authUrl: origin('AUTH_URL', env.AUTH_URL || appUrl.replace('://app.', '://auth.')),
    personasFile,
    caFile,
    label,
    // Unique values (names, PAN, references) derive from label + viewport, so the viewport runs
    // of one label do not collide with each other. run.mjs replaces it with the key an output
    // folder already stores (or its legacy key) so a resumed folder keeps finding its records.
    runKey: runKeyFor(label, viewport.width, viewport.height),
    viewport,
    viewportText,
    outDir,
    headless: bool(args.headed === true ? 'false' : env.HEADLESS, true),
    slowMo: Number(args.slowmo ?? env.SLOWMO ?? 0),
    // Pause after each step so a viewer can read the screen; also a short beat after captions.
    pace: Number(args.pace ?? env.PACE ?? 600),
    captions: bool(args.captions ?? env.CAPTIONS, true),
    demoFilesDir: env.DEMO_FILES || '',
    stepTimeout: Number(env.STEP_TIMEOUT_MS || 360_000),
    actionTimeout: Number(env.ACTION_TIMEOUT_MS || 45_000),
    navTimeout: Number(env.NAV_TIMEOUT_MS || 120_000),
  };
}

/** Short, stable, label-derived values so repeated runs never collide with each other or the manual run. */
export function uniqueValues(label) {
  // 9-digit Nepali PAN: prefix 7 (the manual run used 609…), then 8 digits hashed from the label.
  let h = 2166136261;
  for (const ch of label) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const pan = '7' + String(h % 100_000_000).padStart(8, '0');
  const slug = label.toLowerCase();
  return {
    suffix: ` SCR-${label}`,
    pan,
    // `mr-`, not the `scr-` of runs before 20 Nov 2026: their upper-case labels lower-cased to the
    // same local part (anu.scr-scr1-1440), so a new scr1 run would find SCR1's mail.
    emailLocal: `anu.mr-${slug}`,
    // The local part a customer created before that change has; read only when resuming such a folder.
    legacyEmailLocal: `anu.scr-${slug}`,
    bankRef: (n) => `BOS-DEMO-PAY-0${n}-${label}`,
  };
}
