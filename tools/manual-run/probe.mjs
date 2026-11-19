#!/usr/bin/env node
// Step-authoring helper: sign in as a persona through the Dev switcher, open a page and list its
// visible controls by accessible role and name (what getByRole/getByLabel will match), plus the
// page text. Nothing is recorded. Output is redacted like the runner's: URLs lose their query and
// fragment, password, code and hidden inputs print `[hidden]`, and registered secrets are replaced.
// `--origins` lists the origins the page requested; requests outside the configured origins are
// blocked and listed either way.
//
//   node tools/manual-run/probe.mjs --persona "Dev Sales" --url /leads/new [--viewport 390x844] [--text] [--origins] [--shot file.png]
/* global document, getComputedStyle, CSS -- referenced inside page.evaluate, which runs in the browser */
import { loadConfig, parseArgs } from './lib/config.mjs';
import { launch } from './lib/browser.mjs';
import { originOf } from './lib/origins.mjs';
import { redactText, redactUrl } from './lib/redact.mjs';
import { origins } from './lib/runner.mjs';
import { Session } from './lib/session.mjs';

const print = (line) => console.log(redactText(line));

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig({ label: 'probe', ...args, captions: 'false' });
const browser = await launch(cfg, [cfg.appUrl], origins(cfg));
const context = await browser.newContext({ viewport: cfg.viewport, ignoreHTTPSErrors: false });
context.setDefaultTimeout(cfg.actionTimeout);
const session = await Session.open({
  context,
  cfg,
  state: {},
  log: (l) => console.error(redactText(l)),
});
const requested = new Map();
session.page.on('request', (r) => {
  const o = originOf(r.url()) ?? new URL(r.url()).protocol;
  requested.set(o, (requested.get(o) ?? 0) + 1);
});
try {
  if (args.persona) await session.switchTo(String(args.persona));
  if (args.url) await session.goto(String(args.url), (p) => p.locator('main, body'));
  if (args.wait)
    await session.page.getByText(String(args.wait)).first().waitFor({ timeout: 120000 });
  else await session.page.waitForTimeout(Number(args.settle ?? 3000));
  const rows = await session.page.evaluate(() => {
    const sel =
      'a[href],button,input,select,textarea,[role=button],[role=tab],[role=combobox],[role=checkbox],[role=radio],[role=switch],[role=option],[role=menuitem],summary';
    const out = [];
    const all = [];
    const walk = (root) => {
      root.querySelectorAll(sel).forEach((e) => all.push(e));
      root.querySelectorAll('*').forEach((h) => h.shadowRoot && walk(h.shadowRoot));
    };
    walk(document);
    for (const e of all) {
      const r = e.getBoundingClientRect();
      const cs = getComputedStyle(e);
      if (
        !(r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none') &&
        e.type !== 'file'
      )
        continue;
      const labelled = e.getAttribute('aria-labelledby');
      const lbl =
        e.getAttribute('aria-label') ||
        (labelled &&
          labelled
            .split(' ')
            .map((id) => document.getElementById(id)?.innerText)
            .join(' ')) ||
        (e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)?.innerText) ||
        e.closest('label')?.innerText ||
        '';
      const role =
        e.getAttribute('role') || e.tagName.toLowerCase() + (e.type ? `[${e.type}]` : '');
      // Never print what a password, one-time code or hidden field holds.
      const secret =
        e.tagName === 'INPUT' &&
        (['password', 'hidden'].includes(e.type) ||
          e.autocomplete === 'one-time-code' ||
          /code|otp|pass|secret|token/i.test(e.name || ''));
      const txt = secret
        ? '[hidden]'
        : (e.innerText || e.value || e.getAttribute('placeholder') || '').trim();
      const href = e.getAttribute('href')?.replace(/[?#].*$/s, '');
      out.push(
        `${role} label="${lbl.trim().replace(/\s+/g, ' ').slice(0, 60)}" text="${txt.replace(/\s+/g, ' ').slice(0, 60)}"` +
          (href ? ` href=${href}` : '') +
          (e.disabled || e.getAttribute('aria-disabled') === 'true' ? ' DISABLED' : '') +
          (e.name ? ` name=${e.name}` : ''),
      );
    }
    return out;
  });
  print(`URL ${redactUrl(session.page.url())}`);
  print(rows.join('\n'));
  if (args.text)
    print(
      '\n--- text ---\n' +
        (await session.page.locator('body').innerText()).slice(0, Number(args.max ?? 6000)),
    );
  if (args.origins)
    print('\n--- requested origins ---\n' + [...requested].map(([o, n]) => `${o} ${n}`).join('\n'));
  for (const url of session.blockedUrls) print(`BLOCKED ${url}`);
  if (args.shot) await session.page.screenshot({ path: String(args.shot), fullPage: true });
} catch (error) {
  console.error(redactText(`probe: ${error.message.split('\n')[0]}`));
  process.exitCode = 1;
} finally {
  await browser.close();
}
// Nothing else may keep the process alive (forwarders are unref'd, but say it plainly).
process.exit(process.exitCode ?? 0);
