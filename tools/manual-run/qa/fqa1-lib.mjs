/* global document, window -- referenced inside page.evaluate callbacks, which run in the browser */
// FQA1 (final QA, part 1): one recorded clip per flow per size. Built on the QA harness and the
// manual-run library; development and test tooling only. Credentials are read in code and never printed
// (everything written goes through the library's redactor).
import { mkdirSync, writeFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { openQA, makeCtx, Recorder } from './harness.mjs';
import { redactText, redactUrl } from '../lib/redact.mjs';
import { Session } from '../lib/session.mjs';

export const FQA = process.env.FQA_EVIDENCE || '/home/crestia/bos-runtimes/round5/evidence/FQA1';
export const SIZES = {
  mobile: '390x844',
  tablet: '834x1194',
  laptop: '1280x800',
  desktop: '1440x900',
};

const slug = (t) =>
  String(t)
    .replace(/[^a-z0-9]+/gi, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '');

/** Side-effects ledger: every record the pass creates or changes on the stack. */
export function ledger(entry) {
  const file = path.join(FQA, 'side-effects.jsonl');
  mkdirSync(FQA, { recursive: true });
  writeFileSync(file, JSON.stringify({ when: new Date().toISOString(), ...entry }) + '\n', {
    flag: 'a',
  });
}

/** Append one issue to issues.md (found, severity, area, repro). */
export function logIssue({ id, severity, area, found, repro, size = '' }) {
  const file = path.join(FQA, 'issues.md');
  mkdirSync(FQA, { recursive: true });
  const seen = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (seen.includes(`### ${id}\n`)) return;
  const head = seen
    ? ''
    : `# ${process.env.FQA_NAME ?? 'FQA1'} issue log\n\nFound, severity, area, repro. Nothing is fixed here (no app code edits).\n\n`;
  writeFileSync(
    file,
    `${head}### ${id}\n- found: ${found}\n- severity: ${severity}\n- area: ${area}\n- size: ${size || 'all'}\n- repro: ${repro}\n\n`,
    { flag: 'a' },
  );
}

/**
 * Run the clips of one size. Each clip gets its own browser context (so at most one context is open at a
 * time, well under the 2-context cap) with video recording on, and the file is saved as
 * clips/<area>-<flow>-<size>.webm. `flows` is a list of { area, flow, persona, steps(c, S) }.
 */
export async function runSize(sizeName, flows, { only } = {}) {
  const viewport = SIZES[sizeName];
  process.env.VIDEO_DIR = path.join(FQA, 'run');
  const qa = await openQA({ label: `fqa1${sizeName}`, viewport });
  await qa.context.close().catch(() => {}); // the harness context records nothing; clips use their own
  const rec = new Recorder(path.join(FQA, 'results.json'));
  const results = [];
  const touch = sizeName === 'mobile' || sizeName === 'tablet';
  for (const f of flows) {
    const name = `${f.area}-${f.flow}`;
    if (only && !only.some((o) => name === o || name.startsWith(o + '-'))) continue;
    const clipDir = path.join(FQA, 'clips');
    const tmpDir = path.join(FQA, 'run', `${name}-${sizeName}`);
    mkdirSync(clipDir, { recursive: true });
    mkdirSync(tmpDir, { recursive: true });
    const context = await qa.browser.newContext({
      viewport: qa.cfg.viewport,
      recordVideo: { dir: tmpDir, size: qa.cfg.viewport },
      ignoreHTTPSErrors: false,
      serviceWorkers: 'block',
      locale: 'en-GB',
      acceptDownloads: true,
      hasTouch: touch,
    });
    context.setDefaultTimeout(qa.cfg.actionTimeout);
    const t0 = Date.now();
    const s = await Session.open({
      context,
      cfg: qa.cfg,
      state: {},
      log: (l) => console.error(redactText(l)),
    });
    const page = s.page;
    const video = page.video();
    const c = makeCtx({ s });
    const S = { size: sizeName, viewport, tag: `${sizeName}-${Date.now().toString(36)}`, t0, qa };
    let stopped = false;
    const guide = `${name}-${sizeName}`;
    const stepRows = [];
    /** One recorded step. opts.soft: a FAIL does not stop the flow. */
    const step = async (id, title, fn, opts = {}) => {
      if (stopped) return null;
      const at = ((Date.now() - t0) / 1000).toFixed(1);
      c.controls = [];
      s.checks.length = 0;
      let status = 'PASS';
      let error = '';
      try {
        await fn(c, S);
      } catch (e) {
        status = 'FAIL';
        error = redactText(String(e.message ?? e).split('\n')[0]).slice(0, 400);
      }
      await page.waitForTimeout(Number(process.env.FQA_PACE ?? 1200)).catch(() => {});
      const shotDir = path.join(FQA, 'shots', sizeName);
      mkdirSync(shotDir, { recursive: true });
      const shot = path.join(shotDir, `${name}-${slug(id)}.png`);
      let url = '';
      try {
        url = redactUrl(page.url());
        await page.screenshot({ path: shot, fullPage: false });
      } catch {
        /* best effort */
      }
      const row = {
        guide,
        id,
        area: f.area,
        flow: f.flow,
        size: sizeName,
        title,
        status,
        persona: c.persona ?? s.persona,
        url,
        controls: c.controls.slice(),
        shot: existsSync(shot) ? shot : '',
        clip: `clips/${guide}.webm`,
        clipAt: Number(at),
        error,
        soft: !!opts.soft,
        when: new Date().toISOString(),
      };
      rec.put(row);
      stepRows.push(row);
      console.log(`[${guide} ${id}] ${status} ${title}${error ? ' :: ' + error : ''}`);
      if (status === 'FAIL' && !opts.soft) stopped = true;
      return row;
    };
    try {
      await f.steps(c, S, step);
      stopped = false;
      await step(
        'z-layout',
        'No page of the flow scrolls sideways at this size',
        async () => {
          const bad = c.layoutIssues ?? [];
          if (bad.length) throw new Error(bad.join('; '));
        },
        { soft: true },
      );
    } catch (e) {
      console.error(`flow ${guide} threw: ${redactText(String(e.message).split('\n')[0])}`);
      stopped = true;
    }
    await context.close().catch(() => {});
    let clip = '';
    try {
      const src = await video.path();
      const dst = path.join(clipDir, `${guide}.webm`);
      renameSync(src, dst);
      clip = dst;
      const bytes = statSync(dst).size;
      if (bytes < 2000) throw new Error(`clip is only ${bytes} bytes`);
    } catch (e) {
      console.error(`clip for ${guide}: ${String(e.message).split('\n')[0]}`);
    }
    results.push({
      guide,
      clip,
      pass: stepRows.filter((r) => r.status === 'PASS').length,
      fail: stepRows.filter((r) => r.status === 'FAIL').length,
    });
  }
  await qa.browser.close().catch(() => {});
  return results;
}

/** The sidebar, the icon rail or the menu drawer, whichever this size shows: open a nav link by its href. */
export async function goNav(c, S, label, href) {
  const p = c.page();
  const link = () => p.locator(`a[href="${href}"]`).filter({ hasText: label }).first();
  if (
    !(await link()
      .isVisible()
      .catch(() => false))
  ) {
    const menu = p.getByRole('button', { name: /^Open menu$/ });
    if (await menu.isVisible().catch(() => false)) await menu.click();
  }
  if (
    !(await link()
      .isVisible()
      .catch(() => false))
  )
    throw new Error(`nav link "${label}" (${href}) is not reachable at ${S.viewport}`);
  const clicked = await link()
    .click({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) {
    // Something sits on top of the link (at 834px the floating Dev chip covers the Settings icon).
    await link().focus();
    await p.keyboard.press('Enter');
    c.controls.push(`note: ${label} was covered at ${S.viewport}; opened it from the keyboard`);
    logIssue({
      id: `I-04 ${label} ${S.size}`,
      severity: 'low',
      area: 'navigation (dev tooling)',
      found: `The floating Dev chip covers the "${label}" link in the icon rail at ${S.viewport}, so a pointer cannot reach it`,
      repro: `Dev Finance at ${S.viewport}, Overview: the Settings gear at the bottom of the rail sits under the Dev chip (dev-only overlay)`,
      size: S.size,
    });
  }
  await p.waitForURL((u) => u.pathname === href || u.pathname.startsWith(href + '/'), {
    timeout: 60000,
  });
  await p.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  c.controls.push(`nav link ${label} (${href}) clicked`);
}

/** The page itself must not scroll sideways (a table may scroll inside its own box). */
export async function noSideScroll(c, what = '') {
  const m = await c.page().evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
  }));
  const ok = m.sw <= m.iw + 1;
  c.controls.push(
    `${ok ? 'no' : 'HAS'} horizontal page scroll${what ? ' on ' + what : ''} (${m.sw}/${m.iw})`,
  );
  // Recorded, not thrown: the flow goes on, and a final soft step reports every wide page.
  if (!ok)
    (c.layoutIssues ??= []).push(
      `${what || c.page().url()}: page ${m.sw}px wide in a ${m.iw}px window`,
    );
}

/** A control that matters is inside the viewport horizontally once scrolled into view. */
export async function reachable(c, locator, desc) {
  const l = locator.first();
  await l.scrollIntoViewIfNeeded();
  const box = await l.boundingBox();
  const vw = c.page().viewportSize().width;
  c.ok(
    !!box && box.x >= -1 && box.x + box.width <= vw + 1 && box.width > 0,
    `${desc} is reachable inside the ${vw}px viewport`,
    JSON.stringify(box),
  );
}

/**
 * Type a date into the nth app date picker (react-aria segments, in the display locale's order) in `scope`.
 * `iso` is YYYY-MM-DD. Each segment is found by its label, so the locale's order does not matter.
 */
export async function pickDate(c, nth, iso, scope = c.page()) {
  const [y, m, d] = iso.split('-');
  const group = scope.locator('[role=group]:has([role=spinbutton])').nth(nth);
  const seg = (name) => group.locator(`[role=spinbutton][aria-label^="${name}"]`).first();
  await seg('month').waitFor({ state: 'visible', timeout: 30000 });
  await c
    .page()
    .waitForLoadState('networkidle', { timeout: 15000 })
    .catch(() => {});
  for (const [name, text] of [
    ['day', d],
    ['month', m],
    ['year', y],
  ]) {
    await seg(name).click();
    await c.page().keyboard.type(text, { delay: 60 });
  }
  c.controls.push(`date picker #${nth + 1} set to ${iso}`);
}
