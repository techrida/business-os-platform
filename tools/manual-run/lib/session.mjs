// The things every step does through the real UI: captions, navigation that survives the dev
// server compiling a route, the Dev account switcher, custom dropdowns, typeahead pickers and
// native file choosers. Workflows call these instead of raw Playwright where a pattern repeats.
/* global window, document -- referenced inside page.evaluate callbacks, which run in the browser */
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

export class StepFailure extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Overlay drawn in the recorded page only. pointer-events:none keeps it out of hit testing, so it
// never blocks a click. The text comes from Node through an exposed function, so it survives
// navigations and origin changes (app, sign-in, portal, mail).
const CAPTION_SCRIPT = `(() => {
  if (window.top !== window) return;
  const draw = (text) => {
    let host = document.getElementById('__manual_run_caption');
    if (!text) { host && host.remove(); return; }
    if (!host) {
      host = document.createElement('div'); host.id = '__manual_run_caption';
      host.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:2147483647;pointer-events:none;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = '<div style="margin:0 8px 8px;padding:6px 10px;border-radius:6px;background:rgba(17,24,39,.86);color:#fff;font:600 13px/1.35 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3);max-height:3.4em;overflow:hidden"></div>';
      (document.body || document.documentElement).appendChild(host);
    }
    host.shadowRoot.firstChild.textContent = text;
  };
  // Insert only after React has hydrated <body> (an extra node before that breaks hydration);
  // pages without React (sign-in, Mailpit) get the caption after 3 s.
  let ready = false;
  window.__manualRunDraw = (t) => { if (ready) draw(t); };
  const pull = () => { if (window.__manualRunCaption) window.__manualRunCaption().then(draw).catch(() => {}); };
  const started = Date.now();
  const wait = () => {
    const b = document.body;
    const hydrated = b && Object.keys(b).some((k) => k.startsWith('__reactFiber'));
    const nonReact = b && Date.now() - started > 3000 && !document.getElementById('__next') && !document.querySelector('script[src*="/_next/"]');
    if (hydrated || nonReact || Date.now() - started > 60000) { ready = true; pull(); return; }
    setTimeout(wait, 250);
  };
  wait();
})();`;

export class Session {
  constructor({ context, page, cfg, state, log }) {
    this.context = context;
    this.page = page;
    this.cfg = cfg;
    this.state = state;
    this.log = log;
    this.captionText = '';
    this.checks = [];
    this.findings = [];
    this.persona = null;
    this.consoleErrors = [];
  }

  watch(page) {
    const add = (kind, text) => {
      if (/React DevTools|preloaded using link preload/.test(text)) return;
      this.consoleErrors.push(
        `${kind}: ${text.replace(/\s+/g, ' ').slice(0, 300)} @ ${page.url()}`,
      );
    };
    page.on('pageerror', (e) => add('pageerror', e.message));
    page.on('console', (m) => m.type() === 'error' && add('console', m.text()));
    return page;
  }

  static async open({ context, cfg, state, log }) {
    if (cfg.captions) {
      const s = { text: '' };
      await context.exposeFunction('__manualRunCaption', () => s.text);
      await context.addInitScript(CAPTION_SCRIPT);
      const page = await context.newPage();
      const session = new Session({ context, page, cfg, state, log });
      session._captionStore = s;
      session.watch(page);
      return session;
    }
    const page = await context.newPage();
    const session = new Session({ context, page, cfg, state, log });
    session.watch(page);
    return session;
  }

  // ---- captions -------------------------------------------------------------------------------
  async caption(text) {
    this.captionText = text;
    if (this._captionStore) this._captionStore.text = text;
    this.log(`  · ${text}`);
    if (!this.cfg.captions) return;
    for (const p of this.context.pages()) {
      await p
        .evaluate((t) => window.__manualRunDraw && window.__manualRunDraw(t), text)
        .catch(() => {});
    }
    await sleep(Math.min(this.cfg.pace, 800));
  }

  // ---- assertions -----------------------------------------------------------------------------
  /** Wait until the locator is visible; fail the step with a sentence a person can act on. */
  async see(locator, message, timeout = this.cfg.actionTimeout) {
    try {
      await locator.first().waitFor({ state: 'visible', timeout });
    } catch {
      throw new StepFailure(
        `Expected to see: ${message} (not visible after ${Math.round(timeout / 1000)} s on ${this.page.url()})`,
      );
    }
    this.checks.push(`saw: ${message}`);
  }

  async seeText(text, message = `"${text}"`, timeout) {
    const loc =
      typeof text === 'string'
        ? this.page.getByText(text, { exact: false })
        : this.page.getByText(text);
    return this.see(loc, message, timeout);
  }

  expect(condition, message, detail = '') {
    if (!condition)
      throw new StepFailure(`Expected: ${message}${detail ? ` (actual: ${detail})` : ''}`);
    this.checks.push(`ok: ${message}`);
  }

  async notVisible(locator, message, settleMs = 1500) {
    await sleep(settleMs);
    const n = await locator.count();
    let visible = false;
    for (let i = 0; i < n; i++)
      if (
        await locator
          .nth(i)
          .isVisible()
          .catch(() => false)
      )
        visible = true;
    if (visible) throw new StepFailure(`Expected NOT to see: ${message}`);
    this.checks.push(`absent: ${message}`);
  }

  /** A product defect seen on the way; the step continues and the finding goes to results. */
  finding(text, severity = 'normal') {
    this.findings.push({ severity, text });
    this.log(`  ! finding (${severity}): ${text}`);
  }

  record(key, value) {
    this.state[key] = value;
    this.log(`  = ${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);
  }

  need(key) {
    const v = this.state[key];
    if (v === undefined || v === null || v === '')
      throw new StepFailure(`An earlier step did not record "${key}"`);
    return v;
  }

  // ---- navigation -----------------------------------------------------------------------------
  /**
   * Load a URL and wait for a concrete control. The dev server compiles a route on first hit and
   * can reset connections under load; a Chrome error page or the app's "This page did not open"
   * screen triggers up to three reloads, 15 s apart.
   */
  async goto(url, ready, { page = this.page, attempts = 4 } = {}) {
    const full = url.startsWith('http') ? url : this.cfg.appUrl + url;
    let lastError = '';
    for (let i = 1; i <= attempts; i++) {
      try {
        if (i === 1 || page.url() !== full)
          await page.goto(full, { waitUntil: 'domcontentloaded' });
        else await page.reload({ waitUntil: 'domcontentloaded' });
        await this.waitReady(ready, page);
        return;
      } catch (error) {
        lastError = error.message.split('\n')[0];
        this.log(`    (load ${i}/${attempts} of ${full} not ready: ${lastError.slice(0, 140)})`);
        if (i < attempts) await sleep(i === 1 ? 5000 : 15000);
      }
    }
    throw new StepFailure(`Page ${full} did not become ready: ${lastError}`);
  }

  async waitReady(ready, page = this.page) {
    if (page.url().startsWith('chrome-error://')) throw new Error('browser error page');
    if (!ready) return;
    const target = typeof ready === 'function' ? ready(page) : ready;
    const broken = page.getByText(/This page did not open|Application error|Internal Server Error/);
    const winner = await Promise.race([
      target
        .first()
        .waitFor({ state: 'visible', timeout: this.cfg.navTimeout })
        .then(() => 'ok'),
      broken
        .first()
        .waitFor({ state: 'visible', timeout: this.cfg.navTimeout })
        .then(() => 'broken'),
    ]);
    if (winner === 'broken') throw new Error('app error screen');
  }

  // ---- accounts -------------------------------------------------------------------------------
  /** One-click development sign-in through the real /dev/personas page (same context, same video). */
  async switchTo(name) {
    if (this.persona === name) return;
    await this.caption(`${this.captionText.split(' — ')[0]} — switch to ${name}`);
    const button = (p) => p.getByRole('button', { name, exact: true });
    await this.goto('/dev/personas', button);
    await button(this.page).click();
    await this.page.waitForURL((u) => !u.pathname.startsWith('/dev/'), {
      timeout: this.cfg.navTimeout,
    });
    await this.page.waitForLoadState('domcontentloaded');
    const who = await this.whoami();
    this.expect(who && who.userId, `signed in as ${name}`, JSON.stringify(who));
    this.persona = name;
    this.checks.push(`persona ${name} (roles ${who.roles.join(',')})`);
    return who;
  }

  async whoami(page = this.page) {
    let last = null;
    for (let i = 0; i < 8; i++) {
      await page.waitForLoadState('load').catch(() => {});
      last = await page
        .evaluate(async () => {
          const res = await fetch('/dev/api/whoami', { credentials: 'include', cache: 'no-store' });
          return res.ok ? res.json() : { status: res.status };
        })
        .catch((e) => ({ error: e.message.split('\n')[0] }));
      if (last.userId) return last;
      await sleep(3000);
    }
    this.log(`    (whoami not ready: ${JSON.stringify(last)})`);
    return null;
  }

  // ---- controls -------------------------------------------------------------------------------
  button(name, { exact = true, page = this.page } = {}) {
    return page.getByRole('button', { name, exact });
  }

  link(name, { exact = true, page = this.page } = {}) {
    return page.getByRole('link', { name, exact });
  }

  field(label, { exact = true, page = this.page } = {}) {
    return page.getByLabel(label, { exact });
  }

  /**
   * The dev server streams HTML long before React hydrates it; a click on a server-rendered button
   * before hydration does nothing. React attaches `__reactProps$…` to a DOM node when it hydrates
   * it, so wait for that key (elements outside React, e.g. the shadow-DOM Dev menu, are skipped).
   */
  async hydrated(locator, timeout = 45000) {
    const el = locator.first();
    await el.waitFor({ state: 'visible', timeout: this.cfg.actionTimeout });
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const state = await el
        .evaluate((node) => {
          if (node.getRootNode() !== document) return 'outside';
          return Object.keys(node).some((k) => k.startsWith('__reactProps')) ? 'ready' : 'waiting';
        })
        .catch(() => 'waiting');
      if (state !== 'waiting') return;
      await sleep(250);
    }
    this.log('    (element never hydrated; continuing)');
  }

  async click(locator, what) {
    await locator
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await this.hydrated(locator);
    await locator.first().click();
    if (what) this.checks.push(`clicked ${what}`);
  }

  async fill(label, value, { exact = true } = {}) {
    const f = typeof label === 'string' ? this.field(label, { exact }) : label;
    await this.hydrated(f);
    await f.first().fill(String(value));
  }

  /** The app's custom select: a listbox trigger button found by its label (or its hidden input name). */
  select(label, { scope = this.page, byName = false, exact = true } = {}) {
    const trigger = 'button[aria-haspopup="listbox"]';
    if (byName)
      return scope
        .locator(`input[type="hidden"][name="${label}"]`)
        .locator('xpath=..')
        .locator(trigger);
    return scope.locator(trigger).and(scope.getByLabel(label, { exact }));
  }

  /**
   * Custom dropdown (Department, Currency, Source, Payment method …): click the trigger, then the
   * role=option by its visible name (or by data-key when `{ key }` is given). These are NOT native
   * selects; `selectOption` would only touch a hidden input.
   */
  async choose(trigger, option, { scope = this.page, exact = true } = {}) {
    const t = (typeof trigger === 'string' ? this.select(trigger, { scope }) : trigger).first();
    await t.scrollIntoViewIfNeeded().catch(() => {});
    await this.hydrated(t);
    await t.click();
    const id = await t.getAttribute('aria-controls');
    const list = id ? this.page.locator(`[id="${id}"]`) : this.page.getByRole('listbox');
    const opt =
      typeof option === 'object'
        ? list.locator(`[role="option"][data-key="${option.key}"]`)
        : list.getByRole('option', { name: option, exact });
    await opt.first().waitFor({ state: 'visible', timeout: 20000 });
    await opt.first().click();
    await list
      .first()
      .waitFor({ state: 'hidden', timeout: 10000 })
      .catch(() => {});
  }

  /**
   * Typeahead picker (memo signers, approver pickers): a combobox you type into, then the option
   * whose own name line is exactly `name` (a prefix match would pick "Dev Finance Two" for "Dev Finance").
   */
  async typeahead(box, name, { scope = this.page } = {}) {
    const el = (
      typeof box === 'string' ? scope.getByRole('combobox', { name: box, exact: true }) : box
    ).first();
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await this.hydrated(el);
    await el.click();
    await el.fill(name);
    const option = this.page
      .getByRole('option')
      .filter({ has: this.page.getByText(new RegExp(`^${esc(name)}(?: \\(.+\\))?$`)) });
    await option.first().waitFor({ state: 'visible', timeout: 30000 });
    await option.first().click();
  }

  /** A button that opens the native file chooser (headless-safe). */
  async chooseFile(buttonLocator, file) {
    await this.hydrated(buttonLocator);
    const [chooser] = await Promise.all([
      this.page.waitForEvent('filechooser', { timeout: 20000 }),
      buttonLocator.first().click(),
    ]);
    await chooser.setFiles(file);
  }

  /** Click and capture a download; returns { path, bytes, name }. */
  async download(locator, saveDir) {
    await this.hydrated(locator);
    const [d] = await Promise.all([
      this.page.waitForEvent('download', { timeout: 90000 }),
      locator.first().click(),
    ]);
    const path = `${saveDir}/${d.suggestedFilename()}`;
    await d.saveAs(path);
    const bytes = readFileSync(path);
    return { path, bytes, name: d.suggestedFilename() };
  }

  async text(locator = this.page.locator('main').or(this.page.locator('body'))) {
    return (
      await locator
        .first()
        .innerText()
        .catch(() => '')
    ).replace(/\s+/g, ' ');
  }

  async pause(ms = this.cfg.pace) {
    if (ms > 0) await sleep(ms);
  }
}

// ---- real sign-in (password + one-time code), used for the portal and the private-window check --
export function readPersona(file, key) {
  const list = JSON.parse(readFileSync(file, 'utf8'));
  const p = list.find((r) => r.key === key);
  if (!p)
    throw new StepFailure(
      `Persona key "${key}" is not in PERSONAS_FILE (keys: ${list.map((r) => r.key).join(', ')})`,
    );
  return p;
}

export function totp(secret, now = Date.now()) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of secret.replace(/[\s=]/g, '').toUpperCase())
    bits += A.indexOf(ch).toString(2).padStart(5, '0');
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const ctr = Buffer.alloc(8);
  ctr.writeBigUInt64BE(BigInt(Math.floor(now / 30000)));
  const h = createHmac('sha1', key).update(ctr).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** Types the login into ZITADEL's own form. Values are never logged. */
export async function realLogin(session, page, key, startUrl) {
  const p = readPersona(session.cfg.personasFile, key);
  const host = new URL(startUrl).host;
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
  const loginName = page.locator('input[name=loginName]');
  await loginName.waitFor({ state: 'visible', timeout: session.cfg.navTimeout });
  await loginName.fill(p.preferredLoginName || p.username);
  await page.locator('button[type=submit]', { hasText: 'Continue' }).click();
  const pw = page.locator('input[type=password]');
  await pw.waitFor({ state: 'visible' });
  await pw.fill(p.password);
  await page.locator('button[type=submit]', { hasText: 'Continue' }).click();
  if (p.totpSecret) {
    const code = page.locator('input[name=code]');
    await code.waitFor({ state: 'visible', timeout: 60000 });
    const left = 30 - (Math.floor(Date.now() / 1000) % 30);
    if (left < 5) await sleep((left + 1) * 1000);
    await code.fill(totp(p.totpSecret));
    const moved = await page
      .waitForURL((u) => new URL(u).host === host, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    if (!moved) {
      const b = page.locator('button[type=submit]', { hasText: 'Continue' });
      if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
    }
  }
  await page.waitForURL((u) => new URL(u).host === host && !/\/auth\//.test(new URL(u).pathname), {
    timeout: session.cfg.navTimeout,
  });
}
