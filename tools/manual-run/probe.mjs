#!/usr/bin/env node
// Step-authoring helper: sign in as a persona through the Dev switcher, open a page and list its
// visible controls by accessible role and name (what getByRole/getByLabel will match), plus the
// page text. Nothing is recorded.
//
//   node tools/manual-run/probe.mjs --persona "Dev Sales" --url /leads/new [--viewport 390x844] [--text] [--shot file.png]
/* global document, getComputedStyle, CSS -- referenced inside page.evaluate, which runs in the browser */
import { loadConfig, parseArgs } from './lib/config.mjs';
import { launch } from './lib/browser.mjs';
import { origins } from './lib/runner.mjs';
import { Session } from './lib/session.mjs';

const args = parseArgs(process.argv.slice(2));
const cfg = loadConfig({ label: 'probe', ...args, captions: 'false' });
const browser = await launch(cfg, origins(cfg));
const context = await browser.newContext({ viewport: cfg.viewport, ignoreHTTPSErrors: false });
context.setDefaultTimeout(cfg.actionTimeout);
const session = await Session.open({ context, cfg, state: {}, log: (l) => console.error(l) });
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
      const txt = (e.innerText || e.value || e.getAttribute('placeholder') || '').trim();
      out.push(
        `${role} label="${lbl.trim().replace(/\s+/g, ' ').slice(0, 60)}" text="${txt.replace(/\s+/g, ' ').slice(0, 60)}"` +
          (e.getAttribute('href') ? ` href=${e.getAttribute('href')}` : '') +
          (e.disabled || e.getAttribute('aria-disabled') === 'true' ? ' DISABLED' : '') +
          (e.name ? ` name=${e.name}` : ''),
      );
    }
    return out;
  });
  console.log(`URL ${session.page.url()}`);
  console.log(rows.join('\n'));
  if (args.text)
    console.log(
      '\n--- text ---\n' +
        (await session.page.locator('body').innerText()).slice(0, Number(args.max ?? 6000)),
    );
  if (args.shot) await session.page.screenshot({ path: String(args.shot), fullPage: true });
} finally {
  await browser.close();
}
