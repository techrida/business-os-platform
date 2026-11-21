#!/usr/bin/env node
// FG-Q2: capture the Figma-comparison pages that earlier passes missed, signing in per role with the
// real ZITADEL sign-in (not the Dev switcher). One role context at a time.
//   node tools/manual-run/qa/fgq2.mjs --role founder [--only slug,slug]
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { openQA, EVIDENCE } from './harness.mjs';
import { realLogin } from '../lib/session.mjs';
import { redactText, redactUrl } from '../lib/redact.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const role = arg('role', 'founder');
const plan = arg('plan', role);
const only = arg('only', '')?.split(',').filter(Boolean);
const OUT = path.join(EVIDENCE, 'fgq2');
mkdirSync(OUT, { recursive: true });
const manifestFile = path.join(OUT, 'manifest.json');
const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : [];
const save = (row) => {
  const i = manifest.findIndex((r) => r.slug === row.slug && r.role === row.role);
  if (i >= 0) manifest[i] = row;
  else manifest.push(row);
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  console.log(`[fgq2 ${row.role}] ${row.slug}: ${row.status}${row.note ? ' :: ' + row.note : ''}`);
};

const qa = await openQA({ label: `fgq${role.replace(/[^a-z0-9]/g, '')}` });
const { s } = qa;
const page = () => s.page;
const hrefs = async (sel) =>
  page()
    .locator(sel)
    .evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href')))]);

async function shot(slug, route, { prep, note } = {}) {
  if (only?.length && !only.includes(slug)) return;
  const row = { slug, role, route, status: 'captured', note: note ?? '', desktop: '', mobile: '' };
  try {
    await s.page.setViewportSize({ width: 1440, height: 900 });
    await s.goto(route, (p) => p.locator('main, body').first());
    await page()
      .waitForLoadState('networkidle', { timeout: 15000 })
      .catch(() => {});
    if (prep) await prep(page());
    await page().waitForTimeout(800);
    row.finalUrl = redactUrl(page().url());
    row.desktop = `${slug}__${role}__desktop.png`;
    await page().screenshot({ path: path.join(OUT, row.desktop), fullPage: true });
    await s.page.setViewportSize({ width: 390, height: 844 });
    await page().waitForTimeout(600);
    row.mobile = `${slug}__${role}__mobile.png`;
    await page().screenshot({ path: path.join(OUT, row.mobile), fullPage: true });
    await s.page.setViewportSize({ width: 1440, height: 900 });
    row.title = (
      await page()
        .locator('h1')
        .first()
        .innerText()
        .catch(() => '')
    ).slice(0, 80);
  } catch (e) {
    row.status = 'unreachable';
    row.note = redactText(String(e.message).split('\n')[0]).slice(0, 300);
  }
  save(row);
}

/** Open a dialog on a record page by clicking a button, screenshot it, close without confirming. */
async function dialog(slug, route, buttonName, { prep } = {}) {
  if (only?.length && !only.includes(slug)) return;
  const row = { slug, role, route, status: 'captured', note: '', desktop: '', mobile: '' };
  try {
    await s.page.setViewportSize({ width: 1440, height: 900 });
    await s.goto(route, (p) => p.locator('main, body').first());
    await page()
      .waitForLoadState('networkidle', { timeout: 15000 })
      .catch(() => {});
    if (prep) await prep(page());
    const btn = page().getByRole('button', { name: buttonName }).first();
    if (!(await btn.isVisible().catch(() => false)))
      throw new Error(`no visible button ${buttonName} on ${route}`);
    if (await btn.isDisabled()) throw new Error(`button ${buttonName} is disabled on ${route}`);
    await s.hydrated(btn);
    await btn.click({ delay: 120 });
    await page().getByRole('dialog').first().waitFor({ state: 'visible', timeout: 15000 });
    await page().waitForTimeout(700);
    row.desktop = `${slug}__${role}__desktop.png`;
    await page().screenshot({ path: path.join(OUT, row.desktop) });
    await s.page.setViewportSize({ width: 390, height: 844 });
    await page().waitForTimeout(500);
    row.mobile = `${slug}__${role}__mobile.png`;
    await page().screenshot({ path: path.join(OUT, row.mobile) });
    await s.page.setViewportSize({ width: 1440, height: 900 });
    row.title = (
      await page()
        .getByRole('dialog')
        .first()
        .getByRole('heading')
        .first()
        .innerText()
        .catch(() => '')
    ).slice(0, 80);
    await page().keyboard.press('Escape');
  } catch (e) {
    row.status = 'unreachable';
    row.note = redactText(String(e.message).split('\n')[0]).slice(0, 300);
  }
  save(row);
}

const { PLANS } = await import('./fgq2-plans.mjs');
try {
  if (plan !== 'login' && plan !== 'loginpassword') {
    console.log('signing in for real as role', role);
    await realLogin(s, page(), role, qa.cfg.appUrl + '/');
    await page().waitForLoadState('domcontentloaded');
  }
  await PLANS[plan]({ s, page, hrefs, shot, dialog, qa, OUT, save });
} catch (e) {
  console.log('fgq2 error:', redactText(String(e.message).split('\n')[0]));
  process.exitCode = 1;
} finally {
  await qa.browser.close().catch(() => {});
}
process.exit(process.exitCode ?? 0);
