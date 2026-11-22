// The things every step does through the real UI: captions, navigation that survives the dev
// server compiling a route, the Dev account switcher, custom dropdowns, typeahead pickers and
// native file choosers. Workflows call these instead of raw Playwright where a pattern repeats.
/* global window, document, getComputedStyle -- referenced inside page.evaluate callbacks, which run in the browser */
import { readFileSync } from 'node:fs';

import { configuredOrigins, OriginError, originAllowed, requireOrigin } from './origins.mjs';
import {
  redactText,
  redactUrl,
  registerCode,
  registerSecret,
  registerTotpSecret,
} from './redact.mjs';
import { totp, claimCode } from './totp.mjs';

export { totp };

// The app's route error panel ("This page/sales order/… did not open") or a raw server error.
const BROKEN_PAGE = /\bdid not open\b|Application error|Internal Server Error/;

export class StepFailure extends Error {}

/** state.json key: when a step last ran out of time (ISO). Not a record of the app. */
export const LAST_TIMEOUT_KEY = 'lastTimeoutAt';
/** How long after a timeout an adoption lookup waits, for a request sent at the deadline to land. */
export const SETTLE_MS = 8000;

/**
 * A list's empty state: its exact title, or any of several (app versions word it differently),
 * each matched like `getByText(title, { exact: true })` and combined with `or`.
 */
export const emptyStateLocator = (page, empty) =>
  [empty]
    .flat()
    .map((title) => page.getByText(title, { exact: true }))
    .reduce((all, one) => all.or(one));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A wait that ends (rejecting with the abort reason) when `signal` aborts. */
export function abortableSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
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
    // Aborted when the step runs out of time: Node-side waits (Mailpit polling, pauses) end with it.
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    // Called after every record() so state.json follows each server-side change (the runner sets it).
    this.persist = null;
    this.blockedUrls = new Set();
  }

  /**
   * The step ran out of time. Its body may still be inside an action; from now on every Session
   * helper refuses to act, and all network requests of this session's windows are aborted, so
   * nothing it still does (including a raw dialog click) reaches the server while the failure is
   * captioned, screenshotted and the context closes. The workflow ends after a failed step.
   */
  async abort(reason) {
    if (this.abortReason) return;
    this.abortReason = reason;
    this.controller.abort(new StepFailure(reason));
    for (const c of [this.context, ...(this.windows ?? [])])
      await c.route('**/*', (route) => route.abort('aborted')).catch(() => {});
  }

  guard() {
    if (this.abortReason) throw new StepFailure(`Stopped: ${this.abortReason}`);
  }

  /**
   * Closes every window of the session at once (the step ran out of time): pending Playwright
   * waits end and the browser's sockets close. Their pages are kept in `closedPages`, so their
   * videos are still named afterwards.
   */
  async closeWindows() {
    const contexts = [this.context, ...(this.windows ?? [])].filter(Boolean);
    this.closedPages ??= this.context ? [...this.context.pages()] : [];
    await Promise.all(contexts.map((c) => c.close().catch(() => {})));
  }

  /**
   * A step that timed out may have sent a request just before its windows closed, and the server
   * can still commit it. Before a lookup that decides whether to adopt or create a record, wait
   * until `ms` after the last timeout recorded in state.json.
   */
  async settleAfterTimeout(ms = SETTLE_MS) {
    const at = Date.parse(this.state?.[LAST_TIMEOUT_KEY] ?? '');
    const left = Number.isNaN(at) ? 0 : at + ms - Date.now();
    if (left <= 0) return;
    this.checks.push(
      `note: waited ${Math.ceil(left / 1000)} s after an earlier time-out before the lookup`,
    );
    await abortableSleep(left, this.signal);
  }

  /**
   * Requests (and WebSockets) to any origin outside APP/PORTAL/MAIL/AUTH are aborted in the browser
   * and reported as a finding of the current step (URL without its query). Installed on every
   * context before its first page opens. Session.abort's later route runs before this one.
   */
  async guardContext(context) {
    const allowed = configuredOrigins(this.cfg);
    // The route handler sees only the first request of a redirect chain: Chromium follows a 3xx to
    // another origin without asking it again. Those hops are detected below (a redirected request,
    // a page that landed elsewhere) and stop the step; only network isolation prevents them.
    context.on('page', (page) => this.guardPage(page));
    context.on('request', (request) => {
      if (!request.redirectedFrom() || originAllowed(request.url(), allowed)) return;
      let page = null;
      try {
        page = request.frame().page();
      } catch {
        // a request without a frame (none expected with service workers blocked)
      }
      this.leftOrigins(request.url(), page, 'followed a redirect');
    });
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (originAllowed(url, allowed)) return route.continue();
      this.blocked(url);
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket(/.*/, (ws) => {
      if (originAllowed(ws.url(), allowed)) ws.connectToServer();
      else {
        this.blocked(ws.url());
        ws.close().catch(() => {});
      }
    });
  }

  /** Every main-frame navigation of `page` (main window, private window, popups) is checked. */
  guardPage(page) {
    if (this.guardedPages?.has(page)) return;
    (this.guardedPages ??= new WeakSet()).add(page);
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.checkPageOrigin(page);
    });
    this.checkPageOrigin(page);
  }

  /**
   * False (and the step is stopped) when `page` is no longer on a configured origin. Chrome's own
   * error page (a 502 from the dev server) and browser-local pages are not a different site.
   */
  checkPageOrigin(page) {
    const url = page.url();
    if (/^chrome-error:/.test(url) || originAllowed(url, configuredOrigins(this.cfg))) return true;
    this.leftOrigins(url, page, 'navigated');
    return false;
  }

  /** checkPageOrigin for a step: fails it at once when the page left the configured origins. */
  assertPageOrigin(page = this.page) {
    if (!this.checkPageOrigin(page)) throw new StepFailure(this.abortReason);
  }

  /**
   * The browser reached an origin outside the configured ones (a redirect the route guard cannot
   * see). From this moment nothing is typed or clicked: the step is aborted, the page is sent to
   * about:blank and a high finding is recorded.
   */
  leftOrigins(url, page, how) {
    const clean = redactUrl(url);
    if (!this.leftOriginsAt) {
      this.leftOriginsAt = clean;
      this.findings.push({
        severity: 'high',
        text: `The browser ${how} outside the configured origins: ${clean}`,
      });
      this.log(`  ! the browser ${how} outside the configured origins: ${clean}`);
    }
    void this.abort(`The browser ${how} outside the configured origins (${clean}); stopped`);
    if (page && !page.isClosed?.()) void page.goto('about:blank').catch(() => {});
  }

  blocked(url) {
    const clean = redactUrl(url);
    if (this.blockedUrls.has(clean)) return;
    this.blockedUrls.add(clean);
    this.findings.push({
      severity: 'high',
      text: `Blocked a request outside the configured origins: ${clean}`,
    });
    this.log(`  ! blocked a request outside the configured origins: ${clean}`);
  }

  watch(page) {
    const add = (kind, text) => {
      if (/React DevTools|preloaded using link preload/.test(text)) return;
      this.consoleErrors.push(
        `${kind}: ${redactText(text).replace(/\s+/g, ' ').slice(0, 300)} @ ${redactUrl(page.url())}`,
      );
    };
    page.on('pageerror', (e) => add('pageerror', e.message));
    page.on(
      'console',
      (m) =>
        m.type() === 'error' &&
        !/Failed to load resource/.test(m.text()) &&
        add('console', m.text()),
    );
    page.on('response', (r) => r.status() >= 500 && add(`http ${r.status()}`, redactUrl(r.url())));
    page.on('requestfailed', (r) =>
      add('request failed', `${r.failure()?.errorText} ${redactUrl(r.url())}`),
    );
    return page;
  }

  static async open({ context, cfg, state, log }) {
    const store = { text: '' };
    await Session.prepareContext(context, cfg, store);
    const session = new Session({ context, page: null, cfg, state, log });
    await session.guardContext(context);
    session.page = await context.newPage();
    session._captionStore = store;
    session.watch(session.page);
    return session;
  }

  static async prepareContext(context, cfg, store) {
    if (!cfg.captions) return;
    await context.exposeFunction('__manualRunCaption', () => store.text);
    await context.addInitScript(CAPTION_SCRIPT);
  }

  /**
   * A second, separately signed-in browser window (e.g. a private window). It is recorded as its own
   * video next to the workflow's main video and shows the same captions.
   */
  async openWindow(name) {
    const context = await this.browser.newContext({
      viewport: this.cfg.viewport,
      recordVideo: { dir: this.dirs.video, size: this.cfg.viewport },
      ignoreHTTPSErrors: false,
      serviceWorkers: 'block',
    });
    context.setDefaultTimeout(this.cfg.actionTimeout);
    context.setDefaultNavigationTimeout(this.cfg.navTimeout);
    await Session.prepareContext(context, this.cfg, this._captionStore);
    await this.guardContext(context);
    const page = this.watch(await context.newPage());
    this.extraContexts = [...(this.extraContexts ?? []), { name, context, pages: [page] }];
    this.windows = [...(this.windows ?? []), context];
    return { context, page };
  }

  // ---- captions -------------------------------------------------------------------------------
  async caption(raw) {
    const text = redactText(raw);
    this.captionText = text;
    if (this._captionStore) this._captionStore.text = text;
    this.log(`  · ${text}`);
    if (!this.cfg.captions) return;
    for (const p of [this.context, ...(this.windows ?? [])].flatMap((c) => c.pages())) {
      await p
        .evaluate((t) => window.__manualRunDraw && window.__manualRunDraw(t), text)
        .catch(() => {});
    }
    await sleep(Math.min(this.cfg.pace, 800));
  }

  // ---- assertions -----------------------------------------------------------------------------
  /** Wait until the locator is visible; fail the step with a sentence a person can act on. */
  async see(locator, message, timeout = this.cfg.actionTimeout) {
    this.guard();
    try {
      await this.recoverable(locator, timeout);
    } catch {
      throw new StepFailure(
        `Expected to see: ${message} (not visible after ${Math.round(timeout / 1000)} s on ${redactUrl(this.page.url())})`,
      );
    }
    this.checks.push(`saw: ${message}`);
  }

  /**
   * Wait for a locator. When the dev server drops a route chunk (502 → ChunkLoadError) the app
   * shows its "… did not open" panel instead; reload (a plain GET) up to twice and note it.
   */
  async recoverable(locator, timeout) {
    const broken = this.page.getByText(BROKEN_PAGE);
    for (let reloads = 0; ; reloads++) {
      const winner = this.page.url().startsWith('chrome-error://')
        ? 'broken'
        : await Promise.race([
            locator
              .first()
              .waitFor({ state: 'visible', timeout })
              .then(() => 'ok'),
            broken
              .first()
              .waitFor({ state: 'visible', timeout })
              .then(() => 'broken'),
            // A navigation answered 502 (the dev server restarting) lands on Chrome's error page.
            this.page
              .waitForURL(/^chrome-error:/, { timeout })
              .then(() => 'broken')
              .catch(() => new Promise(() => {})),
          ]);
      if (winner === 'ok') return;
      if (reloads >= 3) throw new Error('error page after three reloads');
      const where = redactUrl(this.page.url());
      this.checks.push(`note: error page on ${where}, reloaded (${reloads + 1})`);
      this.log(`    (error page on ${where}, reloading)`);
      await sleep(reloads === 0 ? 5000 : 15000);
      await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
    }
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

  /**
   * Keeps a value for later steps and writes state.json at once, so a stop right after a
   * server-side change still leaves its record. Refused after the step timed out: a body that
   * finishes late must not change the run's records.
   */
  record(key, value) {
    this.guard();
    this.state[key] = value;
    this.persist?.();
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
    const full = this.resolve(url);
    let lastError = '';
    for (let i = 1; i <= attempts; i++) {
      this.guard();
      try {
        if (i === 1 || page.url() !== full)
          await page.goto(full, { waitUntil: 'domcontentloaded' });
        else await page.reload({ waitUntil: 'domcontentloaded' });
        this.assertPageOrigin(page);
        await this.waitReady(ready, page);
        this.assertPageOrigin(page);
        return;
      } catch (error) {
        if (this.abortReason) throw new StepFailure(this.abortReason);
        lastError = error.message.split('\n')[0];
        this.log(`    (load ${i}/${attempts} of ${full} not ready: ${lastError.slice(0, 140)})`);
        if (i < attempts) await sleep(i === 1 ? 5000 : 15000);
      }
    }
    throw new StepFailure(`Page ${full} did not become ready: ${lastError}`);
  }

  /**
   * A path is resolved on APP_URL; an absolute URL must be on one of the configured origins
   * (APP, PORTAL, MAIL, AUTH), anything else fails the step before the browser goes there.
   */
  resolve(url) {
    const full = new URL(String(url), this.cfg.appUrl).href;
    try {
      requireOrigin(full, configuredOrigins(this.cfg), 'Navigation');
    } catch (error) {
      if (error instanceof OriginError) throw new StepFailure(error.message);
      throw error;
    }
    return full;
  }

  async waitReady(ready, page = this.page) {
    if (page.url().startsWith('chrome-error://')) throw new Error('browser error page');
    if (!ready) return;
    const target = typeof ready === 'function' ? ready(page) : ready;
    const broken = page.getByText(BROKEN_PAGE);
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
    this.guard();
    if (this.persona === name) return;
    await this.caption(`${this.captionText.split(' — ')[0]} — switch to ${name}`);
    const button = (p) => p.getByRole('button', { name, exact: true });
    let who = null;
    // A switch is idempotent; a dev-server restart in the middle of one is retried from the start.
    for (let attempt = 1; attempt <= 3 && !who; attempt++) {
      await this.goto('/dev/personas', button);
      await this.hydrated(button(this.page));
      await button(this.page).click();
      const left = await this.page
        .waitForURL((u) => !u.pathname.startsWith('/dev/'), { timeout: this.cfg.navTimeout })
        .then(() => true)
        .catch(() => false);
      if (left) {
        await this.page.waitForLoadState('domcontentloaded');
        who = await this.whoami();
      }
      if (!who) this.log(`    (switch to ${name} not confirmed, attempt ${attempt}/3)`);
    }
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
  async hydrated(locator, timeout = 30000) {
    const el = locator.first();
    // Five attempts: after a dev-server restart the first compile of a route can take minutes.
    for (let attempt = 0; attempt < 5; attempt++) {
      this.guard();
      await el.waitFor({ state: 'visible', timeout: this.cfg.actionTimeout });
      const until = Date.now() + timeout;
      let state = 'unknown';
      while (Date.now() < until) {
        state = await el
          .evaluate((node) => {
            if (node.getRootNode() !== document) return 'outside';
            if (!document.querySelector('script[src*="/_next/"]')) return 'outside';
            // A stylesheet that answered 502 leaves the page unstyled and controls overlapped.
            // Reload then, but only while no field holds typed input.
            const unstyled = [...document.querySelectorAll('link[rel="stylesheet"]')].some(
              (l) => l.href.includes('/_next/') && !l.sheet,
            );
            const dirty = [...document.querySelectorAll('input, textarea')].some(
              (f) =>
                (f.type === 'checkbox' || f.type === 'radio'
                  ? f.checked !== f.defaultChecked
                  : f.value !== f.defaultValue) && f.type !== 'hidden',
            );
            if (unstyled && !dirty) return 'unstyled';
            if (Object.keys(node).some((k) => k.startsWith('__reactProps'))) return 'ready';
            // The page root hydrated but this element not yet (a Suspense boundary still
            // streaming); versus nothing hydrated at all.
            return Object.keys(document.body).some((k) => k.startsWith('__reactFiber'))
              ? 'partial'
              : 'unhydrated';
          })
          // Detached or mid-navigation: the page moved on, so there is nothing to wait for.
          .catch(() => 'unknown');
        if (state === 'ready' || state === 'outside') return;
        // A route still streaming shows its loading skeleton; give it the full wait.
        await sleep(250);
      }
      // Reload only a page that never hydrated at all (a script chunk answered 502 under load), or
      // an unstyled page with no typed input: neither can lose work. A hydrated page may hold form input, and a page
      // that is navigating may be mid-submit, so neither is ever reloaded.
      if (state !== 'unhydrated' && state !== 'unstyled') {
        this.log(`    (element not hydrated after ${timeout / 1000} s [${state}]; continuing)`);
        return;
      }
      await this.assetsServed(el.page());
      this.log(`    (page ${state} after ${timeout / 1000} s, reloading: ${locator})`);
      await el
        .page()
        .reload({ waitUntil: 'load', timeout: this.cfg.navTimeout })
        .catch(() => {});
    }
    throw new StepFailure(
      `The page never became interactive (React did not hydrate ${locator}) after four reloads`,
    );
  }

  /**
   * After a restart the dev server answers 502 for script chunks and stylesheets while it
   * recompiles, sometimes for minutes; a reload in that window fails the same way. Wait until the
   * page's own /_next/ assets answer 200 again (plain GETs), up to three minutes.
   */
  async assetsServed(page, budgetMs = 180000) {
    const until = Date.now() + budgetMs;
    for (;;) {
      const bad = await page
        .evaluate(async () => {
          const urls = [
            ...[...document.querySelectorAll('script[src*="/_next/"]')].map((e) => e.src),
            ...[...document.querySelectorAll('link[rel="stylesheet"][href*="/_next/"]')].map(
              (e) => e.href,
            ),
          ];
          const codes = await Promise.all(
            urls.map((u) =>
              fetch(u, { cache: 'no-store' })
                .then((r) => r.status)
                .catch(() => 0),
            ),
          );
          return codes.filter((c) => c !== 200).length;
        })
        .catch(() => -1);
      if (bad === 0 || bad === -1 || Date.now() > until) return;
      this.log(`    (dev server still failing ${bad} asset(s); waiting before the reload)`);
      await sleep(10000);
    }
  }

  async click(locator, what) {
    this.guard();
    await locator
      .first()
      .scrollIntoViewIfNeeded()
      .catch(() => {});
    await this.hydrated(locator);
    await locator.first().click();
    if (what) this.checks.push(`clicked ${what}`);
  }

  async fill(label, value, { exact = true } = {}) {
    this.guard();
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
    this.guard();
    if (typeof trigger === 'string' && (await this.select(trigger, { scope }).count()) === 0) {
      // A native <select>: pick the option whose text matches.
      const native = scope.getByLabel(trigger, { exact }).first();
      await this.hydrated(native);
      const labels = await native.locator('option').allInnerTexts();
      const want = labels.find((l) =>
        option instanceof RegExp ? option.test(l) : l.trim() === option,
      );
      if (want === undefined)
        throw new Error(`No option ${option} in "${trigger}" (have: ${labels.join(' | ')})`);
      await native.selectOption({ label: want });
      return;
    }
    const t = (typeof trigger === 'string' ? this.select(trigger, { scope }) : trigger).first();
    await t.scrollIntoViewIfNeeded().catch(() => {});
    await this.hydrated(t);
    // Held for 120 ms: a press that is released in the same tick does not open the react-aria select.
    await t.click({ delay: 120 });
    const id = await t.getAttribute('aria-controls');
    const page = t.page();
    const list = id ? page.locator(`[id="${id}"]`) : page.getByRole('listbox');
    const opt =
      option instanceof RegExp
        ? list.getByRole('option', { name: option })
        : typeof option === 'object'
          ? list.locator(`[role="option"][data-key="${option.key}"]`)
          : list.getByRole('option', { name: option, exact });
    await opt.first().waitFor({ state: 'visible', timeout: 20000 });
    await opt.first().click({ delay: 120 });
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
    this.guard();
    const el = (
      typeof box === 'string' ? scope.getByRole('combobox', { name: box, exact: true }) : box
    ).first();
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await this.hydrated(el);
    await el.click();
    await el.fill(name);
    const page = el.page();
    const option = page
      .getByRole('option')
      .filter({ has: page.getByText(new RegExp(`^${esc(name)}(?: \\(.+\\))?$`)) });
    await option.first().waitFor({ state: 'visible', timeout: 30000 });
    await option.first().click({ delay: 120 });
  }

  /** A button that opens the native file chooser (headless-safe). */
  async chooseFile(buttonLocator, file) {
    this.guard();
    await this.hydrated(buttonLocator);
    const [chooser] = await Promise.all([
      buttonLocator.page().waitForEvent('filechooser', { timeout: 20000 }),
      buttonLocator.first().click(),
    ]);
    await chooser.setFiles(file);
  }

  /** Click and capture a download; returns { path, bytes, name }. */
  async download(locator, saveDir) {
    this.guard();
    await this.hydrated(locator);
    const [d] = await Promise.all([
      locator.page().waitForEvent('download', { timeout: 90000 }),
      locator.first().click(),
    ]);
    const path = `${saveDir}/${d.suggestedFilename()}`;
    await d.saveAs(path);
    const bytes = readFileSync(path);
    return { path, bytes, name: d.suggestedFilename() };
  }

  /**
   * Opens a (filtered) list page and waits for positive evidence that it finished loading: its
   * table (found by caption) or its empty-state text, and no "… did not load" alert. A failed load
   * is retried; when the list never loads the step fails, because "not found" must never be
   * guessed from a list that did not load. Returns the table, or null for an empty list.
   * `empty` is the empty state's exact title, or a list of them (app versions word it differently,
   * e.g. "No matching payments." and "No payments match these filters.").
   */
  async loadList(path, { heading, table, empty, attempts = 4 }) {
    // Every loadList is an adoption lookup (memo, lead, payments): let a late request land first.
    await this.settleAfterTimeout();
    const failure = () =>
      this.page.getByRole('alert').filter({ hasText: /did not load|did not open/ });
    for (let i = 1; i <= attempts; i++) {
      await this.goto(path, (p) =>
        p.getByRole('heading', { level: 1, name: heading, exact: true }),
      );
      const t = this.page.getByRole('table', { name: table, exact: true });
      const e = emptyStateLocator(this.page, empty);
      const wait = (loc, outcome) =>
        loc
          .first()
          .waitFor({ state: 'visible', timeout: this.cfg.navTimeout })
          .then(() => outcome);
      const outcome = await Promise.any([
        wait(t, 'table'),
        wait(e, 'empty'),
        wait(failure(), 'failed'),
      ]).catch(() => 'timeout');
      if (outcome !== 'failed' && outcome !== 'timeout' && (await failure().count()) === 0) {
        this.checks.push(`the ${heading} list loaded (${outcome})`);
        return outcome === 'table' ? t : null;
      }
      this.checks.push(`note: the ${heading} list did not load (${outcome}), attempt ${i}`);
      this.log(`    (the ${heading} list did not load: ${outcome}; attempt ${i}/${attempts})`);
      if (i < attempts) await abortableSleep(i === 1 ? 5000 : 15000, this.signal);
    }
    throw new StepFailure(
      `The ${heading} list did not load after ${attempts} attempts, so it cannot tell whether ` +
        "this run's record already exists; nothing was created. Re-run the step later.",
    );
  }

  /**
   * The distinct paths of links in `table` whose own text is exactly `text` (whitespace collapsed),
   * never a longer text that contains it.
   */
  async exactLinks(table, text) {
    if (!table) return [];
    const found = await table.locator('a[href]').evaluateAll((links) =>
      links.map((a) => ({
        text: a.textContent.replace(/\s+/g, ' ').trim(),
        href: a.getAttribute('href'),
      })),
    );
    return [
      ...new Set(
        found.filter((l) => l.text === text).map((l) => new URL(l.href, this.cfg.appUrl).pathname),
      ),
    ];
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
    if (ms > 0) await abortableSleep(ms, this.signal);
  }
}

// ---- real sign-in (password + one-time code), used for the portal and the private-window check --
/**
 * One persona from PERSONAS_FILE. Every persona's password and TOTP secret in the file is
 * registered with the redactor first, so no console line or result can carry one. Values are
 * never logged.
 */
export function readPersona(file, key) {
  let list;
  try {
    list = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    // A parse error quotes the text around the fault, which can be a password: never pass it on.
    throw new StepFailure(
      error instanceof SyntaxError
        ? 'The personas file (PERSONAS_FILE) is not valid JSON'
        : `The personas file (PERSONAS_FILE) could not be read (${error.code ?? 'error'})`,
    );
  }
  if (!Array.isArray(list))
    throw new StepFailure('The personas file (PERSONAS_FILE) is not a list of personas');
  for (const r of list) {
    registerSecret(r.password);
    registerTotpSecret(r.totpSecret);
  }
  const p = list.find((r) => r.key === key);
  if (!p)
    throw new StepFailure(
      `Persona key "${key}" is not in PERSONAS_FILE (keys: ${list.map((r) => r.key).join(', ')})`,
    );
  return p;
}

// The sign-in page draws the one-time code twice: in the (transparent) input, and digit by digit in
// the visible boxes of the code widget (`.bos-otp-slot` inside input-otp's container). Both are
// made invisible in every document of the sign-in window, before the first page loads, so a code is
// never legible in the video or a failure screenshot.
export const LOGIN_MASK_CSS = [
  'input[name=code],input[autocomplete=one-time-code]{-webkit-text-security:disc!important;' +
    'color:transparent!important;-webkit-text-fill-color:transparent!important;caret-color:transparent!important}',
  '.bos-otp-slots,.bos-otp-slots *,[data-input-otp-container],[data-input-otp-container] *' +
    '{color:transparent!important;-webkit-text-fill-color:transparent!important;text-shadow:none!important}',
].join('\n');

// A constructed stylesheet is CSSOM, which the login page's Content-Security-Policy does not block.
const LOGIN_MASK_SCRIPT = `(() => {
  const apply = () => {
    if (window.__manualRunMasked) return;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(${JSON.stringify(LOGIN_MASK_CSS)});
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      window.__manualRunMasked = true;
    } catch (e) {}
  };
  apply();
  document.addEventListener('DOMContentLoaded', apply);
})();`;

/**
 * Counts (no values) of the code input and the code boxes, and how many of each are masked. The
 * step refuses to type the code unless there is at least one of each and all are masked.
 */
async function maskState(page) {
  await page.evaluate(LOGIN_MASK_SCRIPT).catch(() => {});
  return page.evaluate(() => {
    const hidden = (el) => {
      const cs = getComputedStyle(el);
      const clear = (c) => c === 'transparent' || c === 'rgba(0, 0, 0, 0)';
      return clear(cs.color) && clear(cs.getPropertyValue('-webkit-text-fill-color'));
    };
    const inputs = [
      ...document.querySelectorAll('input[name=code],input[autocomplete=one-time-code]'),
    ];
    const boxes = [...document.querySelectorAll('.bos-otp-slot,[data-input-otp-container] span')];
    return {
      inputs: inputs.length,
      inputsMasked: inputs.filter(
        (el) =>
          getComputedStyle(el).getPropertyValue('-webkit-text-security') === 'disc' && hidden(el),
      ).length,
      boxes: boxes.length,
      boxesMasked: boxes.filter(hidden).length,
    };
  });
}

/**
 * Types the login into the stack's own sign-in form: login name, password, then a one-time code.
 * Before each value is typed the page must be on AUTH_URL's origin exactly; otherwise nothing is
 * typed. Errors are generic: a Playwright error can quote the typed value, so its message and call
 * log never leave this function.
 */
export async function realLogin(session, page, key, startUrl) {
  const cfg = session.cfg;
  const p = readPersona(cfg.personasFile, key);
  const loginOrigins = [cfg.authUrl];
  let stage = 'open the sign-in page';
  const onLoginPage = (what) => requireOrigin(page.url(), loginOrigins, `Before typing ${what}`);
  try {
    const appOrigin = requireOrigin(startUrl, configuredOrigins(cfg), 'Sign-in start');
    await page.context().addInitScript(LOGIN_MASK_SCRIPT);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    stage = 'reach the login name field';
    const loginName = page.locator('input[name=loginName]');
    await loginName.waitFor({ state: 'visible', timeout: cfg.navTimeout });
    const cont = page.locator('button[type=submit]', { hasText: 'Continue' });
    // The login app is a React page too: a value typed before it hydrates leaves Continue disabled.
    const fillUntilEnabled = async (field, value, what) => {
      for (let i = 0; i < 4; i++) {
        session.guard();
        onLoginPage(what);
        await field.fill('');
        await field.pressSequentially(value, { delay: 20 });
        await cont.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        for (let t = 0; t < 12; t++) {
          if (await cont.isEnabled().catch(() => false)) return;
          await sleep(500);
        }
        await sleep(3000);
      }
    };
    stage = 'type the login name';
    await fillUntilEnabled(loginName, p.preferredLoginName || p.username, 'the login name');
    await cont.click();
    stage = 'reach the password field';
    const pw = page.locator('input[type=password]');
    await pw.waitFor({ state: 'visible' });
    stage = 'type the password';
    await fillUntilEnabled(pw, p.password, 'the password');
    await cont.click();
    if (p.totpSecret) {
      stage = 'reach the one-time code field';
      const code = page.locator('input[name=code]');
      await code.waitFor({ state: 'visible', timeout: 60000 });
      stage = 'mask the one-time code';
      const m = await maskState(page);
      if (!m.inputs || !m.boxes || m.inputsMasked !== m.inputs || m.boxesMasked !== m.boxes)
        throw new StepFailure(
          `Could not mask the one-time code (input ${m.inputsMasked}/${m.inputs}, boxes ` +
            `${m.boxesMasked}/${m.boxes}); not typing it on video`,
        );
      session.checks.push(
        `one-time code masked before typing (input ${m.inputsMasked}/${m.inputs}, boxes ${m.boxesMasked}/${m.boxes})`,
      );
      const left = 30 - (Math.floor(Date.now() / 1000) % 30);
      if (left < 5) await sleep((left + 1) * 1000);
      stage = 'type the one-time code';
      session.guard();
      onLoginPage('the one-time code');
      const value = await claimCode(p.totpSecret);
      registerCode(value);
      session.log(`  · typing the one-time code (masked) at ${new Date().toISOString()}`);
      await code.fill(value);
      const moved = await page
        .waitForURL((u) => new URL(u).origin === appOrigin, { timeout: 15000 })
        .then(() => true)
        .catch(() => false);
      if (!moved) {
        const b = page.locator('button[type=submit]', { hasText: 'Continue' });
        if (await b.isVisible().catch(() => false)) await b.click().catch(() => {});
      }
    }
    stage = 'return to the app';
    await page.waitForURL(
      (u) => new URL(u).origin === appOrigin && !/\/auth\//.test(new URL(u).pathname),
      { timeout: cfg.navTimeout },
    );
  } catch (error) {
    if (session.abortReason) throw new StepFailure(`Stopped: ${session.abortReason}`);
    if (error instanceof StepFailure || error instanceof OriginError)
      throw new StepFailure(redactText(error.message));
    throw new StepFailure(
      `Real sign-in failed while trying to ${stage} (${error?.name === 'TimeoutError' ? 'timed out' : 'a browser action failed'}). ` +
        'The browser error is withheld because it can quote typed credentials.',
    );
  }
}
