// What to capture per role for FG-Q2 (slugs follow figma-pass/gap-analysis-r3/evidence/after/manifest.json).
const UUID = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/|$)/;

async function firstDetail({ s, page }, list, prefix) {
  await s.goto(list, (p) => p.locator('main, body').first());
  await page()
    .waitForLoadState('networkidle', { timeout: 15000 })
    .catch(() => {});
  const all = await page()
    .locator(`main a[href^="${prefix}"]`)
    .evaluateAll((as) => as.map((a) => a.getAttribute('href').split('?')[0]));
  return all.find((h) => UUID.test(h) && h.split('/').length === prefix.split('/').length) ?? null;
}

export const PLANS = {
  async founder(k) {
    const { shot, dialog, save } = k;
    // admin/* moved to settings/* in round 3 (successor pages)
    for (const [old, now] of [
      ['admin', '/settings'],
      ['admin--roles', '/settings/access'],
      ['admin--settings', '/settings/company'],
      ['admin--users', '/settings/users'],
      ['admin--users--new', '/settings/users/new'],
      ['admin--workflows', '/settings/workflows'],
    ])
      await shot(old, now, { note: `old /admin page moved to ${now}` });
    await shot('settings--access--roles', '/settings/access/roles');
    const bill = await firstDetail(k, '/payables/bills', '/payables/bills/');
    if (bill) await shot('payables--bills--id', bill);
    else
      save({
        slug: 'payables--bills--id',
        role: 'founder',
        status: 'unreachable',
        note: 'no bill link on /payables/bills',
      });
    const pr = await firstDetail(k, '/payables/payment-requests', '/payables/payment-requests/');
    if (pr) await shot('payables--payment-requests--id', pr);
    else
      save({
        slug: 'payables--payment-requests--id',
        role: 'founder',
        status: 'unreachable',
        note: 'no payment request link',
      });
    const po = await firstDetail(k, '/procurement/orders', '/procurement/orders/');
    if (po) await shot('procurement--orders--id', po);
    else
      save({
        slug: 'procurement--orders--id',
        role: 'founder',
        status: 'unreachable',
        note: 'no PO link',
      });
    const rc = await firstDetail(k, '/procurement/receipts', '/procurement/receipts/');
    if (rc) await shot('procurement--receipts--id', rc);
    else
      save({
        slug: 'procurement--receipts--id',
        role: 'founder',
        status: 'unreachable',
        note: 'no receipt link',
      });
    await shot('procurement--receipts--new', '/procurement/receipts/new');
    const rfq = await firstDetail(k, '/procurement/rfqs', '/procurement/rfqs/');
    if (rfq) {
      await shot('procurement--rfqs--id', rfq);
      await shot('procurement--rfqs--id--quotations--new', `${rfq}/quotations/new`);
    } else {
      save({
        slug: 'procurement--rfqs--id',
        role: 'founder',
        status: 'unreachable',
        note: 'no RFQ link',
      });
    }
    const qt = await firstDetail(k, '/quotations?status=draft', '/quotations/');
    if (qt) await shot('quotations--id--edit', `${qt}/edit`);
    else
      save({
        slug: 'quotations--id--edit',
        role: 'founder',
        status: 'unreachable',
        note: 'no quotation link',
      });
    // dialogs (opened, never confirmed)
    const lead = await firstDetail(k, '/leads', '/leads/');
    if (lead) {
      await dialog('dialog--delete-lead', lead, /delete/i);
      await dialog('dialog--convert-lead', lead, /convert/i);
    }
    const cust = await firstDetail(k, '/customers', '/customers/');
    if (cust) await dialog('dialog--delete-customer', cust, /delete/i);
    const opp = await firstDetail(k, '/opportunities', '/opportunities/');
    if (opp) await dialog('dialog--mark-won', opp, /mark won|won/i);
    if (qt) {
      await dialog('dialog--approve-quotation', qt, /approve/i);
      await dialog('dialog--reject-quotation', qt, /reject/i);
    }
    await dialog('dialog--file-preview', cust ?? '/customers', /preview|view file|open file/i);
  },
  async sales(k) {
    const { shot } = k;
    await shot('leads', '/leads');
    await shot('opportunities', '/opportunities');
    await shot('quotations', '/quotations');
    await shot('customers', '/customers');
    await shot('activities', '/activities');
    const lead = await firstDetail(k, '/leads', '/leads/');
    if (lead) await shot('leads--id', lead);
    const opp = await firstDetail(k, '/opportunities', '/opportunities/');
    if (opp) await shot('opportunities--id', opp);
    const qt = await firstDetail(k, '/quotations', '/quotations/');
    if (qt) await shot('quotations--id', qt);
    await shot('leads--new', '/leads/new');
  },
  async finance(k) {
    const { shot } = k;
    await shot('invoices', '/invoices');
    await shot('payments', '/payments');
    await shot('receivables--aging', '/receivables/aging');
    await shot('payables--bills', '/payables/bills');
    await shot('payables--payment-requests', '/payables/payment-requests');
    await shot('sales-orders', '/sales-orders');
    const inv = await firstDetail(k, '/invoices', '/invoices/');
    if (inv) await shot('invoices--id', inv);
    await shot('settings--currencies', '/settings/currencies');
  },
  async accountant(k) {
    const { shot } = k;
    await shot('payables--bills', '/payables/bills');
    await shot('invoices', '/invoices');
    await shot('payables--vat-register', '/payables/vat-register');
    await shot('settings--tax', '/settings/tax');
    const bill = await firstDetail(k, '/payables/bills', '/payables/bills/');
    if (bill) await shot('payables--bills--id', bill);
  },
  async procurement(k) {
    const { shot } = k;
    await shot('procurement--requests', '/procurement/requests');
    await shot('procurement--rfqs', '/procurement/rfqs');
    await shot('procurement--orders', '/procurement/orders');
    await shot('vendors', '/vendors');
    const po = await firstDetail(k, '/procurement/orders', '/procurement/orders/');
    if (po) await shot('procurement--orders--id', po);
    await shot('settings--purchasing', '/settings/purchasing');
  },
  async warehouse(k) {
    const { shot } = k;
    await shot('procurement--receipts', '/procurement/receipts');
    await shot('procurement--receipts--new', '/procurement/receipts/new');
    await shot('procurement--orders', '/procurement/orders');
    const rc = await firstDetail(k, '/procurement/receipts', '/procurement/receipts/');
    if (rc) await shot('procurement--receipts--id', rc);
  },
  async depthead(k) {
    const { shot } = k;
    await shot('overview', '/');
    await shot('inbox', '/inbox');
    await shot('memos', '/memos');
    await shot('settings--documents', '/settings/documents');
    await shot('settings--workflows', '/settings/workflows');
    await shot('settings', '/settings');
  },
  // Unauthenticated: the sign-in journey pages (no real sign-in needed to see them).
  async login(k) {
    const { page, save, qa, OUT } = k;
    const fs = await import('node:fs');
    const path = await import('node:path');
    const shotTo = async (slug, note) => {
      await page().setViewportSize({ width: 1440, height: 900 });
      await page().waitForTimeout(1200);
      const d = `${slug}__anonymous__desktop.png`;
      await page().screenshot({ path: path.join(OUT, d), fullPage: true });
      await page().setViewportSize({ width: 390, height: 844 });
      const m = `${slug}__anonymous__mobile.png`;
      await page().screenshot({ path: path.join(OUT, m), fullPage: true });
      await page().setViewportSize({ width: 1440, height: 900 });
      save({
        slug,
        role: 'anonymous',
        route: page().url().split('?')[0],
        status: 'captured',
        desktop: d,
        mobile: m,
        note,
      });
    };
    await page().goto(qa.cfg.appUrl + '/', { waitUntil: 'domcontentloaded' });
    await page()
      .waitForLoadState('networkidle', { timeout: 20000 })
      .catch(() => {});
    await shotTo('login--start', 'sign-in start (login name step)');
    const links = await page()
      .locator('a, button')
      .evaluateAll((els) =>
        els
          .map((e) => ({
            t: (e.innerText || e.getAttribute('aria-label') || '').trim().slice(0, 50),
            h: e.getAttribute('href'),
          }))
          .filter((x) => x.t),
      );
    fs.writeFileSync(path.join(OUT, 'login-controls.json'), JSON.stringify(links, null, 1));
    for (const [slug, re] of [
      ['login--password-recovery', /forgot|reset|recover/i],
      ['login--registration', /register|sign.?up|create (an )?account/i],
    ]) {
      const hit = links.find((l) => re.test(l.t));
      if (!hit) {
        save({
          slug,
          role: 'anonymous',
          status: 'unreachable',
          note: `the sign-in page offers no control matching ${re}; controls seen: ${links
            .map((l) => l.t)
            .join(' | ')
            .slice(0, 200)}`,
        });
        continue;
      }
      await page().getByText(hit.t, { exact: false }).first().click();
      await page().waitForLoadState('domcontentloaded');
      await shotTo(slug, `reached through "${hit.t}"`);
      await page().goto(qa.cfg.appUrl + '/', { waitUntil: 'domcontentloaded' });
    }
  },
  // Password step of the sign-in (only the login name is typed, never a password): where "Forgot password?" lives.
  async loginpassword(k) {
    const { page, save, qa, OUT } = k;
    const path = await import('node:path');
    const { readPersona } = await import('../lib/session.mjs');
    const p = readPersona(qa.cfg.personasFile, 'founder');
    await page().goto(qa.cfg.appUrl + '/', { waitUntil: 'domcontentloaded' });
    const name = page().locator('input[name=loginName]');
    await name.waitFor({ state: 'visible', timeout: 60000 });
    await page().waitForTimeout(2500);
    await name.pressSequentially(p.preferredLoginName || p.username, { delay: 20 });
    await page().locator('button[type=submit]', { hasText: 'Continue' }).click();
    await page().locator('input[type=password]').waitFor({ state: 'visible', timeout: 60000 });
    const shotTo = async (slug, note) => {
      for (const [w, h, tag] of [
        [1440, 900, 'desktop'],
        [390, 844, 'mobile'],
      ]) {
        await page().setViewportSize({ width: w, height: h });
        await page().waitForTimeout(800);
        await page().screenshot({
          path: path.join(OUT, `${slug}__anonymous__${tag}.png`),
          fullPage: true,
        });
      }
      await page().setViewportSize({ width: 1440, height: 900 });
      save({
        slug,
        role: 'anonymous',
        route: page().url().split('?')[0],
        status: 'captured',
        desktop: `${slug}__anonymous__desktop.png`,
        mobile: `${slug}__anonymous__mobile.png`,
        note,
      });
    };
    await shotTo('login--password-step', 'password step reached by typing only the login name');
    const forgot = page()
      .getByRole('link', { name: /forgot|reset/i })
      .or(page().getByRole('button', { name: /forgot|reset/i }))
      .first();
    if (await forgot.isVisible().catch(() => false)) {
      await forgot.click();
      await page().waitForLoadState('domcontentloaded');
      await page().waitForTimeout(2000);
      await shotTo(
        'login--password-recovery',
        'reached through "Forgot password?" on the password step',
      );
    } else
      save({
        slug: 'login--password-recovery',
        role: 'anonymous',
        status: 'unreachable',
        note: 'no forgot/reset control on the password step',
      });
  },
  // Dialogs that exist in the app, opened on QA-created records and never confirmed.
  async salesdialogs(k) {
    const { dialog } = k;
    const fs = await import('node:fs');
    const sh = JSON.parse(
      fs.readFileSync('/home/crestia/bos-runtimes/round5/evidence/QA/shared.json', 'utf8'),
    );
    const lead = sh.qLead || sh.leadUrl;
    await dialog('dialog--mark-contacted', sh.newLead || lead, /Mark contacted/);
    await dialog('dialog--convert-lead', sh.qLead, /Convert to opportunity/);
    await dialog('dialog--mark-lost', sh.newLead || lead, /Mark lost/);
    await dialog('dialog--put-on-hold', sh.newLead || lead, /Put on hold/);
  },
  async inboxdialogs(k) {
    const { s, page, dialog, save } = k;
    await s.goto('/inbox', (p) => p.locator('main'));
    await page()
      .waitForLoadState('networkidle', { timeout: 20000 })
      .catch(() => {});
    const items = await page()
      .locator('main a[href^="/inbox/"]')
      .evaluateAll((as) =>
        as.map(
          (a) => a.getAttribute('href').split('?')[0] + ' :: ' + a.innerText.trim().slice(0, 60),
        ),
      );
    const first = items.find((x) => /\/inbox\/[0-9a-f-]{36}/.test(x));
    if (!first) {
      save({
        slug: 'dialog--approve-quotation',
        role: 'accountant',
        status: 'unreachable',
        note: 'no waiting approval in the inbox of this role',
      });
      return;
    }
    const href = first.split(' :: ')[0];
    await dialog('dialog--approve-request', href, /^Approve/);
    await dialog('dialog--reject-request', href, /^Reject/);
  },
};
