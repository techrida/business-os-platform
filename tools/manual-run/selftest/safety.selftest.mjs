// URL and secret redaction, run-time origin checks, the sign-in's generic errors, shell-safe
// launcher paths, network-isolation choice and step time limits.
// Run: node --test 'tools/manual-run/selftest/*.selftest.mjs'
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, test } from 'node:test';

import { scrubDebugEnv } from '../lib/config.mjs';
import { assertShellSafePath, netnsWanted, shq } from '../lib/netns.mjs';
import { originAllowed, originOf, requireOrigin } from '../lib/origins.mjs';
import {
  clearSecrets,
  redactDeep,
  redactText,
  redactUrl,
  registerSecret,
  registerTotpSecret,
} from '../lib/redact.mjs';
import { withTimeout } from '../lib/runner.mjs';
import {
  LAST_TIMEOUT_KEY,
  readPersona,
  realLogin,
  Session,
  SETTLE_MS,
  StepFailure,
  totp,
} from '../lib/session.mjs';
import { findMail } from '../lib/support.mjs';

const CFG = {
  appUrl: 'https://app.t.localhost:58343',
  portalUrl: 'https://portal.t.localhost:58343',
  mailUrl: 'https://mail.t.localhost:58343',
  authUrl: 'https://auth.t.localhost:58343',
  caFile: '/nonexistent/ca.crt',
  navTimeout: 1000,
  actionTimeout: 1000,
  pace: 0,
  captions: false,
};
const PASSWORD = 'S3cret-pa55"word';
const TOTP_SECRET = 'JBSWY3DPEHPK3PXP';

describe('URL redaction', () => {
  test('drops the query string and fragment of a URL', () => {
    assert.equal(
      redactUrl('https://app.localhost/auth/callback?code=123456&state=abc#frag'),
      'https://app.localhost/auth/callback',
    );
    assert.equal(redactUrl('https://app.localhost/inbox'), 'https://app.localhost/inbox');
    assert.equal(redactUrl('/payments/x?q=a'), '/payments/x');
    assert.equal(redactUrl(undefined), '');
  });

  test('cleans every URL inside free text and leaves other text alone', () => {
    const text =
      'page.goto: net::ERR_FAILED at https://auth.localhost/cb?code=999&state=s1 then ' +
      'http://x.localhost/a#tok and "https://app.localhost/p?x=1" (3 = 3?)';
    const out = redactText(text);
    assert.ok(!/code=|state=|#tok|x=1/.test(out), out);
    assert.match(out, /https:\/\/auth\.localhost\/cb then/);
    assert.match(out, /http:\/\/x\.localhost\/a and/);
    assert.match(out, /"https:\/\/app\.localhost\/p"/);
    assert.match(out, /\(3 = 3\?\)$/);
  });
});

describe('secret redaction', () => {
  afterEach(clearSecrets);

  test('a fake Playwright error with the password, the code and the secret is redacted', () => {
    registerSecret(PASSWORD);
    registerTotpSecret(TOTP_SECRET);
    const now = Date.now();
    const codes = [now - 30000, now, now + 30000].map((t) => totp(TOTP_SECRET, t));
    const error =
      `locator.pressSequentially: Timeout 45000ms exceeded.\nCall log:\n` +
      `  - waiting for locator('input[type=password]')\n` +
      `  - fill(${JSON.stringify(PASSWORD)}) and typed ${PASSWORD}\n` +
      `  - fill("${codes[0]}") fill("${codes[1]}") fill("${codes[2]}") secret ${TOTP_SECRET}`;
    const out = redactText(error);
    for (const v of [PASSWORD, JSON.stringify(PASSWORD).slice(1, -1), TOTP_SECRET, ...codes])
      assert.ok(!out.includes(v), `still holds ${v}: ${out}`);
    assert.match(out, /typed \[redacted\]/);
    assert.equal(
      redactUrl(`https://a.localhost/x/${PASSWORD}?q=1`),
      'https://a.localhost/x/[redacted]',
    );
  });

  test('a code is replaced only where it stands alone; numbers in objects stay numbers', () => {
    registerTotpSecret(TOTP_SECRET);
    const code = totp(TOTP_SECRET);
    assert.equal(redactText(`code ${code}`), 'code [redacted]');
    assert.equal(redactText(`order 9${code}9`), `order 9${code}9`);
    assert.deepEqual(redactDeep({ wallMs: Number(code), text: [`x ${code}`] }), {
      wallMs: Number(code),
      text: ['x [redacted]'],
    });
  });

  test('nothing is registered: text is unchanged', () => {
    assert.equal(redactText('plain 123456 text'), 'plain 123456 text');
  });
});

describe('run-time origin checks', () => {
  const allowed = [CFG.appUrl, CFG.portalUrl, CFG.mailUrl, CFG.authUrl];
  test('only the exact configured origins and browser-local content are allowed', () => {
    for (const ok of [
      `${CFG.appUrl}/inbox?x=1`,
      `${CFG.authUrl}/ui/v2/login`,
      'wss://app.t.localhost:58343/_next/webpack-hmr',
      'data:image/png;base64,AA',
      'blob:https://app.t.localhost:58343/1-2',
      'about:blank',
    ])
      assert.ok(originAllowed(ok, allowed), ok);
    for (const bad of [
      'https://app.t.localhost/inbox', // another port
      'http://app.t.localhost:58343/', // another scheme
      'https://auth.t.localhost.evil.example:58343/',
      'https://evil.example/ui/v2/login',
      'https://user@app.t.localhost:58343/',
      'ftp://app.t.localhost:58343/',
      'not a url',
    ])
      assert.ok(!originAllowed(bad, allowed), bad);
    assert.equal(originOf('wss://App.T.localhost:58343/x'), 'https://app.t.localhost:58343');
  });

  test('requireOrigin names the action and never prints the query', () => {
    assert.equal(requireOrigin(`${CFG.authUrl}/x`, [CFG.authUrl], 'Typing'), CFG.authUrl);
    assert.throws(
      () => requireOrigin('https://evil.example/login?token=abc', [CFG.authUrl], 'Typing'),
      (e) =>
        /Typing: https:\/\/evil\.example\/login is not on/.test(e.message) &&
        !/abc/.test(e.message),
    );
  });

  test('Session navigation resolves paths on APP_URL and refuses other origins', () => {
    const s = new Session({ context: null, page: null, cfg: CFG, state: {}, log: () => {} });
    assert.equal(s.resolve('/inbox'), `${CFG.appUrl}/inbox`);
    assert.equal(s.resolve(`${CFG.mailUrl}/view/1`), `${CFG.mailUrl}/view/1`);
    for (const bad of [
      'https://evil.example/',
      '//evil.example/x',
      'http://app.t.localhost:58343/',
    ])
      assert.throws(() => s.resolve(bad), StepFailure, bad);
  });

  test('a blocked request becomes one finding of the current step, without its query', () => {
    const s = new Session({ context: null, page: null, cfg: CFG, state: {}, log: () => {} });
    s.blocked('https://cdn.example/a.js?token=1');
    s.blocked('https://cdn.example/a.js?token=2');
    assert.equal(s.findings.length, 1);
    assert.match(s.findings[0].text, /https:\/\/cdn\.example\/a\.js$/);
  });

  /** A page and context with just the events and calls the origin watcher uses. */
  const fakeBrowser = (startUrl) => {
    const handlers = {};
    const page = {
      _url: startUrl,
      gone: [],
      url: () => page._url,
      isClosed: () => false,
      mainFrame: () => 'main',
      on: (event, fn) => ((handlers[`page:${event}`] ??= []).push(fn), page),
      goto: async (url) => page.gone.push(url),
      navigate(url, frame = 'main') {
        page._url = frame === 'main' ? url : page._url;
        for (const fn of handlers['page:framenavigated'] ?? []) fn(frame);
      },
    };
    const context = {
      routes: 0,
      on: (event, fn) => (handlers[`context:${event}`] ??= []).push(fn),
      route: async () => context.routes++,
      routeWebSocket: async () => {},
      pages: () => [page],
      emit: (event, arg) => (handlers[`context:${event}`] ?? []).forEach((fn) => fn(arg)),
    };
    return { page, context };
  };

  test('a page that lands on another origin stops the step and goes to about:blank', async () => {
    const { page, context } = fakeBrowser(`${CFG.appUrl}/leads`);
    const s = new Session({ context, page, cfg: CFG, state: {}, log: () => {} });
    await s.guardContext(context);
    context.emit('page', page);
    page.navigate(`${CFG.authUrl}/ui/login`); // a configured origin: fine
    page.navigate('chrome-error://chromewebdata/'); // the dev server's 502: fine
    page.navigate('https://evil.example/frame', 'child'); // a child frame is not the page
    assert.equal(s.abortReason, undefined);
    page.navigate('https://evil.example/phish?code=1');
    assert.match(s.abortReason, /navigated outside the configured origins/);
    assert.ok(!/code=1/.test(s.abortReason));
    assert.deepEqual(page.gone, ['about:blank']);
    assert.equal(s.findings.filter((f) => f.severity === 'high').length, 1);
    // Nothing more is typed or clicked: every helper refuses from now on.
    assert.throws(() => s.guard(), StepFailure);
    await assert.rejects(s.fill(s.page, 'x'), StepFailure);
    assert.throws(() => s.assertPageOrigin(page), StepFailure);
  });

  test('a redirect followed to another origin is detected through the redirected request', async () => {
    const { page, context } = fakeBrowser(`${CFG.appUrl}/`);
    const s = new Session({ context, page, cfg: CFG, state: {}, log: () => {} });
    await s.guardContext(context);
    const request = (url, from) => ({
      url: () => url,
      redirectedFrom: () => from,
      frame: () => ({ page: () => page }),
    });
    context.emit('request', request('https://cdn.example/x.js', null)); // the route guard's job
    context.emit('request', request(`${CFG.appUrl}/b`, {})); // a redirect on the app: fine
    assert.equal(s.abortReason, undefined);
    context.emit('request', request('https://evil.example/r', {}));
    assert.match(s.abortReason, /followed a redirect outside the configured origins/);
    assert.deepEqual(page.gone, ['about:blank']);
  });
});

describe('the real sign-in', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'manual-run-login-'));
  const personasFile = path.join(dir, 'personas.json');
  writeFileSync(
    personasFile,
    JSON.stringify([
      { key: 'sales', username: 'dev.sales', password: PASSWORD, totpSecret: TOTP_SECRET },
    ]),
  );
  after(() => {
    clearSecrets();
    rmSync(dir, { recursive: true, force: true });
  });

  /** A page that is on `at` and whose typing fails like Playwright, quoting the value. */
  const fakePage = (at, typed) => {
    const field = {
      waitFor: async () => {},
      fill: async () => {},
      pressSequentially: async (value) => {
        typed.push(value);
        throw new Error(
          `locator.pressSequentially: Timeout exceeded.\nCall log:\n  - typing ${JSON.stringify(value)}`,
        );
      },
      isEnabled: async () => false,
      isVisible: async () => false,
      click: async () => {},
    };
    return {
      context: () => ({ addInitScript: async () => {} }),
      goto: async () => {},
      url: () => at,
      locator: () => field,
      waitForURL: async () => {},
    };
  };
  const session = () => ({ cfg: { ...CFG, personasFile }, checks: [], guard() {}, log() {} });

  test('a failed input action gives a generic error that quotes no credential', async () => {
    const typed = [];
    await assert.rejects(
      realLogin(
        session(),
        fakePage(`${CFG.authUrl}/ui/v2/login/loginname`, typed),
        'sales',
        `${CFG.appUrl}/`,
      ),
      (e) =>
        e instanceof StepFailure &&
        /while trying to type the login name/.test(e.message) &&
        !e.message.includes('dev.sales') &&
        !/Call log|typing/.test(e.message),
    );
    assert.equal(typed.length, 1);
    // The persona's secrets are now registered: any message that still carried one is redacted.
    assert.ok(!redactText(`x ${PASSWORD} y`).includes(PASSWORD));
  });

  test('nothing is typed on a page outside AUTH_URL', async () => {
    const typed = [];
    await assert.rejects(
      realLogin(
        session(),
        fakePage('https://auth.evil.example/ui/v2/login', typed),
        'sales',
        `${CFG.appUrl}/`,
      ),
      (e) =>
        e instanceof StepFailure && /Before typing the login name: .* is not on/.test(e.message),
    );
    assert.deepEqual(typed, []);
  });
});

describe('debug output and the personas file', () => {
  test('a DEBUG that turns on Playwright logging is refused', () => {
    for (const DEBUG of ['pw:api', 'pw:*', '*', 'express:*,pw:protocol', 'x pw:browser'])
      assert.throws(() => scrubDebugEnv({ DEBUG }), /Unset DEBUG/, DEBUG);
  });

  test('debug variables are removed; the tool and browser paths stay', () => {
    const e = {
      DEBUG: 'express:router',
      DEBUG_FILE: '/tmp/x',
      PWDEBUG: 'console',
      PWDEBUGIMPL: '1',
      PW_DEBUG_CONTROLLER_HEADLESS: '1',
      PLAYWRIGHT_TRACE: '1',
      PLAYWRIGHT_FROM: '/repo/apps/workspace/package.json',
      PLAYWRIGHT_BROWSERS_PATH: '/browsers',
      PATH: '/bin',
    };
    scrubDebugEnv(e);
    assert.deepEqual(Object.keys(e).sort(), [
      'PATH',
      'PLAYWRIGHT_BROWSERS_PATH',
      'PLAYWRIGHT_FROM',
    ]);
  });

  test('a personas file that is not JSON fails without quoting any of it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'manual-run-personas-'));
    const file = path.join(dir, 'personas.json');
    writeFileSync(file, '[{"key":"a","password":"Hunter2-Leak"},, ]');
    try {
      assert.throws(
        () => readPersona(file, 'a'),
        (e) =>
          e instanceof StepFailure &&
          /is not valid JSON$/.test(e.message) &&
          !/Hunter2|password|position/.test(e.message),
      );
      writeFileSync(file, '{"key":"a"}');
      assert.throws(() => readPersona(file, 'a'), /not a list of personas/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('shell-safe paths', () => {
  test('accepts plain absolute paths', () => {
    for (const ok of [
      '/home/crestia/bos-runtimes/manual-run/scr1/1440x900/.net',
      '/home/u/.cache/ms-playwright/chromium-1200/chrome-linux/chrome',
    ])
      assert.equal(assertShellSafePath(ok, 'x'), ok);
  });

  test('refuses anything a shell or socat could read as syntax', () => {
    for (const bad of [
      'relative/path',
      '/a b',
      '/a"b',
      "/a'b",
      '/a$(id)',
      '/a`id`',
      '/a;rm',
      '/a,fork',
      '/a:b',
      '/a\nb',
      '',
      undefined,
    ])
      assert.throws(() => assertShellSafePath(bad, 'VIDEO_DIR'), /VIDEO_DIR must be/, String(bad));
  });

  test('single-quotes for the shell', () => {
    assert.equal(shq('/a/b'), "'/a/b'");
    assert.equal(shq("/a'b"), "'/a'\\''b'");
  });
});

describe('network isolation choice', () => {
  const local = ['https://app.testrun.localhost:58343', 'https://127.0.0.1:1'];
  test('NETNS=0 is refused unless ALLOW_NO_NETNS=1 (or ALLOW_NON_LOCAL_TARGET=1) accepts it', () => {
    assert.throws(
      () => netnsWanted(['https://app.p1.bos.test'], '0', {}),
      /without network isolation.*ALLOW_NO_NETNS=1/s,
    );
    for (const env of [{ ALLOW_NO_NETNS: '1' }, { ALLOW_NON_LOCAL_TARGET: '1' }])
      assert.equal(netnsWanted(['https://app.p1.bos.test'], '0', env), false);
  });
  test('never turns itself off silently for a non-loopback origin', () => {
    for (const mode of ['auto', '1'])
      assert.throws(
        () => netnsWanted([...local, 'https://app.p1.bos.test'], mode, { ALLOW_NO_NETNS: '1' }),
        /NETNS=0 and ALLOW_NO_NETNS=1/,
        mode,
      );
  });
  test('loopback origins are allowed in auto mode', () => {
    assert.equal(typeof netnsWanted(local, 'auto', { ALLOW_NO_NETNS: '1' }), 'boolean');
  });
});

describe('step time limit', () => {
  test('cancels the step first, then fails with the time-limit message', async () => {
    const order = [];
    const never = new Promise(() => {});
    await assert.rejects(
      withTimeout(never, 20, 'sales-7 did not finish within 0.02 s', async () => {
        order.push('cancel');
      }),
      (e) => e instanceof StepFailure && /did not finish/.test(e.message),
    );
    assert.deepEqual(order, ['cancel']);
  });
  test('a body that resolves just after the deadline is still a FAIL', async () => {
    let resolveBody;
    const body = new Promise((r) => (resolveBody = r));
    const outcome = withTimeout(body, 20, 'start-2 did not finish within 0.02 s', async () => {
      // The body finishes while the step is being cancelled.
      resolveBody('late success');
      await new Promise((r) => setTimeout(r, 30));
    });
    await assert.rejects(
      outcome,
      (e) => e instanceof StepFailure && /did not finish/.test(e.message),
    );
  });

  test('after a timeout the step can neither record nor wait', async () => {
    let persisted = 0;
    const context = { route: async () => {}, pages: () => [] };
    const s = new Session({ context, page: null, cfg: CFG, state: {}, log: () => {} });
    s.persist = () => persisted++;
    s.record('memoUrl', '/memos/1');
    assert.equal(persisted, 1, 'record writes state.json at once');
    const waiting = s.pause(60_000);
    await s.abort('start-2 did not finish within 1 s');
    await assert.rejects(waiting, StepFailure);
    assert.throws(() => s.record('memoNumber', 'MEMO-1'), StepFailure);
    assert.equal(s.state.memoNumber, undefined);
    assert.equal(persisted, 1);
    // Mailpit polling stops at once with the step's signal; no request is made.
    await assert.rejects(findMail(CFG, 'subject:x', 60_000, { signal: s.signal }), StepFailure);
  });

  test('at the deadline every window closes at once and its pages are kept for the videos', async () => {
    const closed = [];
    const ctx = (name, pages) => ({
      pages: () => pages,
      route: async () => {},
      close: async () => closed.push(name),
    });
    const s = new Session({
      context: ctx('main', ['p1', 'p2']),
      page: null,
      cfg: CFG,
      state: {},
      log: () => {},
    });
    s.windows = [ctx('private', ['w1'])];
    await s.abort('sales-12 did not finish within 1 s');
    await s.closeWindows();
    assert.deepEqual(closed.sort(), ['main', 'private']);
    assert.deepEqual(s.closedPages, ['p1', 'p2']);
  });

  test('an adoption lookup waits until 8 s after the last time-out, and not otherwise', async () => {
    const s = (state) => new Session({ context: null, page: null, cfg: CFG, state, log: () => {} });
    const timed = async (session, ms) => {
      const t = Date.now();
      await session.settleAfterTimeout(ms);
      return Date.now() - t;
    };
    assert.ok((await timed(s({}), 300)) < 50, 'no time-out: no wait');
    const recent = s({ [LAST_TIMEOUT_KEY]: new Date(Date.now() - 100).toISOString() });
    assert.ok((await timed(recent, 300)) >= 150, 'waits out the rest of the settle period');
    assert.match(recent.checks[0], /waited \d+ s after an earlier time-out/);
    const old = s({ [LAST_TIMEOUT_KEY]: new Date(Date.now() - 10_000).toISOString() });
    assert.ok((await timed(old, 300)) < 50, 'long past: no wait');
    assert.equal(SETTLE_MS, 8000);
  });

  test('a step that finishes in time is not cancelled', async () => {
    let cancelled = false;
    assert.equal(
      await withTimeout(Promise.resolve('done'), 50, 'x', () => (cancelled = true)),
      'done',
    );
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(cancelled, false);
  });
});
