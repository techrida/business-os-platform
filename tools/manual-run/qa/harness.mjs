// Round-5 unit QA harness: independent checks (one failing check never blocks the next), a screenshot
// for every check, and PASS / FAIL / BLOCKED / NOT-RUN with the concrete control that was asserted.
// Built on the manual-run library; development and test tooling only. Reads credentials in code
// (personas file) and never prints them: everything written passes through the library's redactor.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, scrubDebugEnv } from '../lib/config.mjs';
import { launch } from '../lib/browser.mjs';
import { redactDeep, redactText, redactUrl } from '../lib/redact.mjs';
import { origins } from '../lib/runner.mjs';
import { Session } from '../lib/session.mjs';

export const EVIDENCE = process.env.QA_EVIDENCE || '/home/crestia/bos-runtimes/round5/evidence/QA';

export async function openQA({ label = 'qa', viewport = '1440x900' } = {}) {
  scrubDebugEnv();
  if (process.env.ALLOW_NON_LOCAL_TARGET === '1' || process.env.NETNS === '0')
    throw new Error(
      'QA runs only against local origins with network isolation: unset ALLOW_NON_LOCAL_TARGET and NETNS=0',
    );
  process.env.VIDEO_DIR ||= path.join(EVIDENCE, 'run');
  const cfg = loadConfig({ label, viewport, captions: 'false' });
  mkdirSync(cfg.outDir, { recursive: true });
  const browser = await launch(cfg, [cfg.appUrl], origins(cfg));
  const context = await browser.newContext({
    viewport: cfg.viewport,
    ignoreHTTPSErrors: false,
    serviceWorkers: 'block',
    locale: 'en-GB',
    acceptDownloads: true,
  });
  context.setDefaultTimeout(cfg.actionTimeout);
  const s = await Session.open({
    context,
    cfg,
    state: {},
    log: (l) => console.error(redactText(l)),
  });
  return { cfg, browser, context, s };
}

export class Recorder {
  constructor(file) {
    this.file = file;
    this.rows = existsSync(file) ? redactDeep(JSON.parse(readFileSync(file, 'utf8'))) : [];
    mkdirSync(path.dirname(file), { recursive: true });
  }
  put(row) {
    // Several lanes may write the same file: re-read it first so no lane drops another lane's rows.
    if (existsSync(this.file)) {
      try {
        this.rows = redactDeep(JSON.parse(readFileSync(this.file, 'utf8')));
      } catch {
        /* keep the rows in memory */
      }
    }
    const i = this.rows.findIndex((r) => r.guide === row.guide && r.id === row.id);
    const clean = redactDeep(row);
    if (i >= 0) this.rows[i] = clean;
    else this.rows.push(clean);
    writeFileSync(this.file, JSON.stringify(this.rows, null, 2));
  }
}

const slug = (t) =>
  t
    .replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '');

/** Per-run helper object handed to every check body. */
export function makeCtx(qa) {
  const { s } = qa;
  const page = () => s.page;
  const ctx = {
    s,
    controls: [],
    persona: null,
    page,
    async as(name) {
      await s.switchTo(name);
      ctx.persona = name;
    },
    /** Open a route and wait for main content. */
    async open(url) {
      await s.goto(url, (p) => p.locator('main, body').first());
      await page()
        .waitForLoadState('networkidle', { timeout: 15000 })
        .catch(() => {});
    },
    async see(locator, desc, timeout) {
      await s.see(locator, desc, timeout);
      ctx.controls.push(`visible: ${desc}`);
    },
    /** A page that has rendered: a heading in main and no "Loading ..." status. Absence is only proven then. */
    async rendered() {
      const p = page();
      await p
        .locator('main h1, main h2')
        .or(p.getByText('This page could not be found'))
        .first()
        .waitFor({ state: 'visible', timeout: 30000 });
      await p
        .locator('main [role=status]', { hasText: /^Loading/ })
        .first()
        .waitFor({ state: 'hidden', timeout: 30000 })
        .catch(() => {});
    },
    async absent(locator, desc) {
      await ctx.rendered();
      await s.notVisible(locator, desc);
      ctx.controls.push(`absent: ${desc}`);
    },
    ok(cond, desc, detail = '') {
      s.expect(cond, desc, detail);
      ctx.controls.push(`assert: ${desc}`);
    },
    btn: (name, opts) => page().getByRole('button', { name, exact: true, ...opts }),
    link: (name, opts) => page().getByRole('link', { name, exact: true, ...opts }),
    heading: (name, opts = {}) => page().getByRole('heading', { name, ...opts }),
  };
  return ctx;
}

/**
 * Run one check. fn(ctx) throws on failure. A FAIL is re-observed once (reload + rerun) when the check
 * is read-only (opts.mutates false), and both observations are recorded.
 */
export async function check(qa, rec, guide, id, title, fn, opts = {}) {
  const only = process.env.QA_ONLY;
  if (only && !only.split(',').includes(`${guide}:${id}`) && !opts.always) return null;
  const ctx = makeCtx(qa, rec);
  const shotDir = path.join(EVIDENCE, 'shots', guide);
  mkdirSync(shotDir, { recursive: true });
  const shot = path.join(shotDir, `${slug(id)}.png`);
  const attempts = [];
  let status = 'PASS';
  let error = '';
  const max = opts.mutates ? 1 : 2;
  for (let a = 1; a <= max; a++) {
    ctx.controls = [];
    qa.s.checks.length = 0;
    try {
      await fn(ctx);
      status = 'PASS';
      error = '';
      attempts.push({ attempt: a, status: 'PASS' });
      break;
    } catch (e) {
      status = 'FAIL';
      error = redactText(String(e.message ?? e).split('\n')[0]).slice(0, 400);
      attempts.push({ attempt: a, status: 'FAIL', error });
      if (a < max) await qa.s.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
  }
  let url = '';
  try {
    url = redactUrl(qa.s.page.url());
    await qa.s.page.screenshot({ path: shot, fullPage: false });
  } catch {
    /* the screenshot is best effort */
  }
  const row = {
    guide,
    id,
    title,
    status,
    persona: ctx.persona ?? qa.s.persona,
    url,
    controls: ctx.controls,
    shot: existsSync(shot) ? shot : '',
    error,
    attempts,
    classify: opts.classify ?? '',
    flaky: status === 'PASS' && attempts.length > 1,
    when: new Date().toISOString(),
  };
  rec.put(row);
  console.log(`[${guide} ${id}] ${status} ${title}${error ? ' :: ' + error : ''}`);
  return row;
}

export function skip(rec, guide, id, title, status, reason, extra = {}) {
  rec.put({
    guide,
    id,
    title,
    status,
    reason,
    controls: [],
    shot: '',
    when: new Date().toISOString(),
    ...extra,
  });
  console.log(`[${guide} ${id}] ${status} ${title} :: ${reason}`);
}
