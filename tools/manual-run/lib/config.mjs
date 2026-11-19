// Configuration from the environment and the command line. Every value has one source of truth
// here; workflows read `cfg` and never `process.env` directly.
import { existsSync } from 'node:fs';
import path from 'node:path';

const env = process.env;

export const WORKFLOWS = ['start', 'sales', 'procurement', 'branches'];

export function parseViewport(text) {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(String(text ?? '').trim());
  if (!m) throw new Error(`Viewport must look like 1440x900, got "${text}"`);
  return { width: Number(m[1]), height: Number(m[2]) };
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
    throw new Error(`${name} is not a URL: ${JSON.stringify(value)}`);
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

const bool = (v, dflt) =>
  v === undefined || v === '' ? dflt : !/^(0|false|no|off)$/i.test(String(v));

export function loadConfig(args = {}) {
  const label = String(args.label ?? env.RUN_LABEL ?? '').trim();
  if (!/^[A-Za-z0-9-]{1,24}$/.test(label)) {
    throw new Error(
      'Set a run label: --label SCR1 or RUN_LABEL=SCR1 (letters, digits, dashes; max 24).',
    );
  }
  const viewportText = String(args.viewport ?? env.VIEWPORT ?? '1440x900');
  const viewport = parseViewport(viewportText);
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
    // Unique values (names, PAN, references) derive from label + viewport width, so the three
    // viewport runs of one label do not collide with each other.
    runKey: `${label}-${viewport.width}`,
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
    only: args.only ? String(args.only).split(',') : null,
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
    emailLocal: `anu.scr-${slug}`,
    bankRef: (n) => `BOS-DEMO-PAY-0${n}-${label}`,
  };
}
