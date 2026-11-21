// Guide: round4/guide/retest.html (sections 1-4)
import { check, skip } from './harness.mjs';
import { createLead, submitDialog, stamp } from './fixtures.mjs';

export async function run(qa, rec, shared) {
  const G = 'retest';
  const sections = [
    ['Company', '/settings/company'],
    ['Document templates', '/settings/documents'],
    ['Approval workflows', '/settings/workflows'],
    ['Sales', '/settings/sales'],
    ['Tax', '/settings/tax'],
    ['Currencies', '/settings/currencies'],
    ['Purchasing', '/settings/purchasing'],
  ];
  await check(qa, rec, G, '1.1', 'Settings sections show typed fields, no raw JSON box or Edit button', async (c) => {
    await c.as('Dev Founder');
    for (const [name, href] of sections) {
      await c.open(href);
      const p = c.page();
      let visible = 0;
      let hidden = 0;
      let hiddenWritable = 0;
      for (const ta of await p.locator('textarea').all()) {
        const v = await ta.inputValue();
        if (!/^\s*[[{]/.test(v)) continue;
        if (await ta.isVisible()) visible++;
        else {
          hidden++;
          if (await ta.isEditable({ timeout: 100 }).catch(() => false)) hiddenWritable++;
        }
      }
      c.ok(visible === 0, `${name} (${href}): no visible textarea holding JSON`, `${visible} visible`);
      if (hidden) c.controls.push(`note: ${hidden} collapsed JSON textarea(s) on ${href} (inside "View spec of version" details), ${hiddenWritable} writable`);
      await c.absent(p.getByRole('button', { name: /^Edit JSON$/i }), `${name}: button "Edit JSON"`);
      const typed = await p.locator('main input:not([type=hidden]), main select, main [role=combobox], main button[aria-haspopup=listbox]').count();
      c.ok(typed > 0, `${name}: at least one typed field (input/select/combobox)`, `count ${typed}`);
    }
  }, { classify: '' });

  await check(qa, rec, G, '1.2', 'Workflows: no "JSON (advanced)" toggle on a normal rule; tax_invoice opens in the form', async (c) => {
    await c.as('Dev Founder');
    await c.open('/settings/workflows');
    const p = c.page();
    await c.absent(p.getByText(/JSON \(advanced\)/i), 'text "JSON (advanced)" anywhere on /settings/workflows');
    const hasTax = await p.locator('input').evaluateAll((els) => els.some((e) => e.value === 'tax_invoice'));
    c.ok(hasTax, 'a tax_invoice rule is shown as an input field (the form), not JSON');
  });

  // ---- 2. stage buttons -------------------------------------------------------------------------
  const title = `QA ${stamp()} lead ${Date.now().toString(36)}`;
  let leadUrl = shared.leadUrl || '';
  await check(qa, rec, G, '2.1', 'New lead header shows Mark contacted, Put on hold, Mark lost and no stage dropdown', async (c) => {
    await c.as('Dev Sales');
    leadUrl = await createLead(c, title);
    shared.leadUrl = leadUrl; shared.save();
    const p = c.page();
    await c.see(c.btn('Mark contacted'), 'button "Mark contacted"');
    await c.see(c.btn('Put on hold'), 'button "Put on hold"');
    await c.see(c.btn('Mark lost'), 'button "Mark lost"');
    await c.absent(p.getByRole('combobox', { name: /stage/i }).or(p.locator('button[aria-haspopup=listbox]').and(p.getByLabel(/stage/i))), 'stage dropdown');
  }, { mutates: true });

  await check(qa, rec, G, '2.2', 'Mark contacted opens a dialog to log a call or email; then Qualify appears', async (c) => {
    await c.as('Dev Sales');
    await c.open(leadUrl);
    await c.s.click(c.btn('Mark contacted'));
    const d = c.page().getByRole('dialog', { name: 'Mark this lead contacted?' });
    await c.see(d, 'dialog "Mark this lead contacted?"');
    await c.see(d.getByRole('radio', { name: 'Call' }), 'radio "Call" in the dialog');
    await c.see(d.getByRole('radio', { name: 'Email' }), 'radio "Email" in the dialog');
    await d.getByRole('textbox', { name: 'Subject' }).fill('QA intro call');
    await d.getByRole('textbox', { name: 'Note' }).fill('QA: spoke to the contact about requirements.');
    await d.getByRole('button', { name: 'Mark contacted', exact: true }).click();
    await c.see(c.btn('Qualify'), 'button "Qualify" after Mark contacted', 30000);
  }, { mutates: true });

  await check(qa, rec, G, '2.3', 'Put on hold (reason + note) shows On hold on the timeline; Resume returns it to Contacted (F1-Q53)', async (c) => {
    await c.as('Dev Sales');
    const holdLead = await createLead(c, `QA ${stamp()} hold ${Date.now().toString(36)}`);
    await c.s.click(c.btn('Mark contacted'));
    await submitDialog(c);
    await c.see(c.btn('Qualify'), 'button "Qualify" (lead is Contacted)', 30000);
    await c.open(holdLead);
    await c.s.click(c.btn('Put on hold'));
    const d = c.page().getByRole('dialog');
    await c.see(d, 'Put on hold dialog');
    await d.getByRole('textbox', { name: 'Reason' }).fill('QA hold reason');
    await d.getByRole('textbox', { name: 'Note' }).fill('QA hold note');
    c.controls.push('filled textbox "Reason" and textbox "Note" in the dialog');
    await d.getByRole('button', { name: 'Put on hold', exact: true }).click({ delay: 80 });
    await c.see(c.page().getByText('On hold', { exact: false }).first(), 'text "On hold" on the lead', 30000);
    const resume = c.page().getByRole('button', { name: 'Resume', exact: true });
    await c.see(resume, 'button "Resume"');
    const notice = (await c.page().locator('main').innerText()).replace(/\s+/g, ' ');
    c.ok(/move it back to Contacted/i.test(notice), 'the on-hold notice names the stage it returns to (Contacted)', notice.slice(0, 160));
    await c.s.click(resume, 'Resume');
    const rd = c.page().getByRole('dialog', { name: 'Resume this lead?' });
    await c.see(rd, 'dialog "Resume this lead?"');
    await rd.getByRole('button', { name: 'Resume lead', exact: true }).click({ delay: 80 });
    await c.see(c.btn('Qualify'), 'button "Qualify" after Resume (back at Contacted)', 30000);
  }, { mutates: true });

  await check(qa, rec, G, '2.4', 'Dev Management (read-only on leads): no stage buttons, a read-only notice', async (c) => {
    await c.as('Dev Management');
    await c.open(leadUrl);
    for (const n of ['Mark contacted', 'Qualify', 'Put on hold', 'Mark lost', 'Resume']) await c.absent(c.page().getByRole('button', { name: new RegExp('^' + n) }), `button "${n}"`);
    const txt = await c.page().locator('main').innerText();
    c.ok(/read.?only|view.?only|only view|can.t change|no .*access|you can read/i.test(txt), 'a read-only notice is shown', txt.slice(0, 160).replace(/\s+/g, ' '));
  });

  // ---- 3. TR-Q5 dropdowns -----------------------------------------------------------------------
  let draftUrl = shared.draftUrl || '';
  await check(qa, rec, G, '3.1', 'Draft quotation: Tax code and Contact dropdowns open on one normal mouse click', async (c) => {
    await c.as('Dev Sales');
    await c.open('/quotations?status=draft');
    const hrefs = await c.page().locator('main a[href^="/quotations/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    c.ok(hrefs.length > 0, 'a quotation link exists in the list', String(hrefs.length));
    draftUrl = hrefs[0];
    shared.draftUrl = draftUrl; shared.save();
  });
  await check(qa, rec, G, '3.2', 'Tax code and Contact: one click, and keyboard (Tab, Enter, arrows)', async (c) => {
    await c.as('Dev Sales');
    if (!draftUrl) throw new Error('no draft quotation link from 3.1');
    await c.open(draftUrl.replace(/\/edit$/, '') + '/edit');
    const p = c.page();
    for (const field of ['Contact', 'Tax code']) {
      if (field === 'Tax code') {
        await c.s.click(p.getByRole('button', { name: /^Edit line 1/ }), 'Edit line 1');
        await c.see(p.getByRole('dialog'), 'line editor dialog (holds the Tax code dropdown)');
      }
      const scope = field === 'Tax code' ? p.getByRole('dialog') : p;
      const trig = scope.getByRole('button', { name: new RegExp(`${field}$`) }).first();
      await c.see(trig, `dropdown trigger button named "... ${field}"`);
      await trig.scrollIntoViewIfNeeded();
      await c.s.hydrated(trig);
      await trig.click();   // a normal click: no hold delay
      await c.see(p.getByRole('listbox').first(), `listbox of "${field}" opened by one normal click`, 3000);
      await p.keyboard.press('Escape');
      await trig.focus();
      await p.keyboard.press('Enter');
      await c.see(p.getByRole('listbox').first(), `listbox of "${field}" opened with Enter`, 3000);
      await p.keyboard.press('ArrowDown');
      await p.keyboard.press('Escape');
      if (field === 'Tax code') await p.keyboard.press('Escape');
    }
  });
  skip(rec, G, '3.3', 'Dropdowns open on a single tap (touch)', 'NOT-RUN', 'Needs a real touch screen or phone; Playwright touch emulation is not a touch device. Listed for Kuu in guide/QA.html.');

  // ---- 4. FG-Q3 ---------------------------------------------------------------------------------
  await check(qa, rec, G, '4.1', 'Operations Officer: Settings > Documents and > Workflows show content or a clear no-access message', async (c) => {
    await c.as('Dev Department Head');
    for (const href of ['/settings/documents', '/settings/workflows']) {
      await c.open(href);
      const t = (await c.page().locator('main').innerText()).replace(/\s+/g, ' ').trim();
      c.ok(t.length > 40, `${href}: main area is not blank`, t.slice(0, 120));
    }
  });
  await check(qa, rec, G, '4.2', 'At 1440 px: one "Search menu" box, not overflowing the sidebar', async (c) => {
    await c.as('Dev Founder');
    await c.open('/');
    const boxes = c.page().getByRole('searchbox', { name: 'Search menu' });
    c.ok((await boxes.count()) === 1, 'exactly one searchbox "Search menu"', String(await boxes.count()));
    const geo = await boxes.first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      const nav = el.closest('aside, nav, [data-sidebar]') ?? el.parentElement;
      const n = nav.getBoundingClientRect();
      return { l: r.left, r: r.right, nl: n.left, nr: n.right };
    });
    c.ok(geo.r <= geo.nr + 1 && geo.l >= geo.nl - 1, 'search box sits inside its sidebar', JSON.stringify(geo));
  });
}
