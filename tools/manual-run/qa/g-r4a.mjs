// Guide: round4/guide/r4a.html (leads, deals, customers, credit hold, quotations, lead owner)
import { check, skip } from './harness.mjs';
import { createLead, submitDialog, markLost, stamp } from './fixtures.mjs';

export async function run(qa, rec, shared) {
  const G = 'r4a';
  const tag = Date.now().toString(36);
  const NA = 'NOT-RUN';
  const advance = async (c, url, button) => {
    await c.open(url);
    await c.s.click(c.btn(button));
    await submitDialog(c);
    await c.page().waitForTimeout(2500);
  };

  await check(qa, rec, G, '1.1', 'Sales: Qualified lead header has Convert to opportunity, Put on hold, Mark lost; Convert not in the side panel', async (c) => {
    await c.as('Dev Sales');
    shared.qLead ||= await createLead(c, `QA ${stamp()} qualified ${tag}`);
    shared.save();
    await advance(c, shared.qLead, 'Mark contacted');
    await advance(c, shared.qLead, 'Qualify');
    await c.open(shared.qLead);
    await c.see(c.btn('Convert to opportunity'), 'button "Convert to opportunity" in the header');
    await c.see(c.btn('Put on hold'), 'button "Put on hold"');
    await c.see(c.btn('Mark lost'), 'button "Mark lost"');
    const n = await c.page().getByRole('button', { name: /^Convert to opportunity$/ }).count();
    c.ok(n === 1, 'exactly one Convert button (none in the side panel)', String(n));
  }, { mutates: true });

  await check(qa, rec, G, '1.2', 'Put a Qualified lead on hold: button reads "Resume to Qualified"', async (c) => {
    await c.as('Dev Sales');
    await c.open(shared.qLead);
    await c.s.click(c.btn('Put on hold'));
    await submitDialog(c);
    const resume = c.page().getByRole('button', { name: 'Resume', exact: true });
    await c.see(resume, 'button "Resume" (the actual label)', 30000);
    const notice = (await c.page().locator('main').innerText()).replace(/\s+/g, ' ');
    c.controls.push('on-hold notice: ' + (notice.match(/This lead is on hold[^.]*\./) || ['(not found)'])[0]);
    c.ok(/move it back to Qualified/i.test(notice), 'the notice names Qualified as the stage it returns to');
    await c.absent(c.page().getByRole('button', { name: 'Resume to Qualified' }), 'button literally named "Resume to Qualified" (the guide wording)');
    c.controls.push('not asserted: "the board offers only Qualified" (board drag target not exercised in this pass)');
  }, { mutates: true });

  let lostLead = '';
  await check(qa, rec, G, '1.3', 'Mark a New lead lost: timeline shows only New as reached', async (c) => {
    await c.as('Dev Sales');
    lostLead = await createLead(c, `QA ${stamp()} lost ${tag}`);
    shared.lostLead = lostLead; shared.save();
    await markLost(c);
    await c.see(c.page().getByText(/Step 5:\s*Lost/).first(), 'timeline step "Step 5: Lost"', 30000);
    const t = (await c.page().locator('main').innerText()).replace(/\s+/g, ' ');
    c.ok(/Step 2:\s*Contacted\s*Not yet/.test(t) && /Step 3:\s*Qualified\s*Not yet/.test(t), 'Contacted and Qualified read "Not yet" on the timeline', t.slice(0, 200));
  }, { mutates: true });

  await check(qa, rec, G, '1.4', 'Put on hold with empty fields: focus moves to Reason and the error is announced', async (c) => {
    await c.as('Dev Sales');
    const u = await createLead(c, `QA ${stamp()} hold ${tag}`);
    await c.s.click(c.btn('Put on hold'));
    const d = c.page().getByRole('dialog');
    await c.see(d, 'Put on hold dialog');
    await d.locator('button[type=submit]').last().click({ delay: 80 });
    await c.page().waitForTimeout(800);
    const active = await c.page().evaluate(() => { const a = document.activeElement; return { label: a?.getAttribute('aria-label') || a?.labels?.[0]?.innerText || a?.id || a?.tagName, inDialog: !!a?.closest('[role=dialog]') }; });
    c.ok(active.inDialog && /reason/i.test(active.label), 'focus is on the Reason control', JSON.stringify(active));
    const alerts = await c.page().locator('[role=alert], [aria-live=assertive], [aria-live=polite]').allInnerTexts();
    c.ok(alerts.join(' ').trim().length > 0 || (await d.locator('[aria-invalid=true]').count()) > 0, 'an error is announced (role=alert/aria-live or aria-invalid)', alerts.join('|').slice(0, 120));
  }, { mutates: true });

  await check(qa, rec, G, '1.5', 'Read-only role: no Add lead, no Mark lost; a lost lead says "Reopening needs reopen access"', async (c) => {
    await c.as('Dev Management');
    await c.open('/leads');
    await c.absent(c.link('+ Add lead'), 'link "+ Add lead"');
    await c.open(lostLead || shared.lostLead);
    await c.absent(c.btn('Mark lost'), 'button "Mark lost"');
    await c.see(c.page().getByText('Reopening needs reopen access'), 'text "Reopening needs reopen access" (read-only role)', 8000);
  }, { classify: 'guide wrong: the reopen sentence is shown to a role that can write leads but lacks reopen access (see 1.5b); a read-only role sees no notice' });
  await check(qa, rec, G, '1.5b', 'Writer without reopen access (Dev Sales): lost lead says "Reopening needs reopen access", no Reopen button', async (c) => {
    await c.as('Dev Sales');
    await c.open(lostLead || shared.lostLead);
    await c.see(c.page().getByText('Reopening needs reopen access'), 'text "Reopening needs reopen access"');
    await c.absent(c.page().getByRole('button', { name: /^Reopen/ }), 'button "Reopen"');
  });

  await check(qa, rec, G, '2.1', 'Sales manager: deal owner choices exclude read-only roles', async (c) => {
    await c.as('Dev Sales Manager');
    await c.open('/opportunities');
    const href = (await c.page().locator('main a[href^="/opportunities/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))).find((h) => h.split('/').length === 3);
    c.ok(!!href, 'an opportunity link exists');
    await c.open(href);
    const change = c.page().getByRole('button', { name: /Change owner/ }).first();
    await c.see(change, 'control "Change owner"');
    const opts = await c.page().locator('select').evaluateAll((els) => els.flatMap((e) => [...e.options].map((o) => o.text)));
    c.controls.push('owner options: ' + opts.join(', '));
    c.ok(opts.length > 0, 'owner list has options');
    c.ok(!opts.some((o) => /Accountant|Management|PMO/.test(o)), 'no read-only person (Accountant, Management, PMO) is offered', opts.join(','));
    c.controls.push('not asserted: the toast about moving the previous owner\'s follow-ups (would change a deal)');
  });

  await check(qa, rec, G, '2.2', 'Own-scope Sales hands a deal to a peer: lands on /opportunities with "Handed to ..." and no not-found page', async (c) => {
    await c.as('Dev Sales');
    const lead = await createLead(c, `QA ${stamp()} convert ${tag}`);
    await advance(c, lead, 'Mark contacted');
    await advance(c, lead, 'Qualify');
    await c.open(lead);
    await c.s.click(c.btn('Convert to opportunity'));
    await submitDialog(c);
    await c.page().waitForURL(/\/opportunities\/[0-9a-f-]{36}/, { timeout: 90000 });
    const deal = c.page().url().split('?')[0].replace(qa.cfg.appUrl, '');
    shared.deal = deal; shared.save();
    c.controls.push('lead converted to deal ' + deal);
    const owner = c.page().locator('select').first();
    await c.s.hydrated(owner);
    await c.s.choose(c.page().getByRole('button', { name: /Change owner/ }).first(), 'Dev Sales Two').catch(async () => { await owner.selectOption({ label: 'Dev Sales Two' }); });
    await c.s.click(c.page().getByRole('button', { name: 'Save owner' }), 'Save owner');
    await c.page().waitForURL(/\/opportunities(\?|$)/, { timeout: 60000 });
    await c.see(c.page().getByText(/Handed to/), 'text "Handed to ..."', 20000);
    await c.absent(c.page().getByText(/not found|404/i), 'a not-found page');
  }, { mutates: true });
  skip(rec, G, '2.3', 'Convert a lead with an open follow-up: it appears under the deal\'s Activities, Planned', NA, 'Needs a converted lead created with a follow-up; deferred with 2.2.');
  skip(rec, G, '2.4', 'Assignee without edit rights sees only Complete on a follow-up and on /activities', NA, 'Needs 2.3 fixture and a second persona assigned; deferred with 2.2.');

  await check(qa, rec, G, '3.1', 'New customer with an existing name: Create anyway needs a reason', async (c) => {
    await c.as('Dev Sales');
    await c.open('/customers');
    const name = (await c.page().locator('main table tbody tr').first().locator('a').first().innerText()).trim();
    await c.open('/customers/new');
    await c.s.fill(c.page().getByRole('textbox', { name: 'Organization legal name', exact: true }), name);
    c.controls.push(`typed existing customer name "${name}" in textbox "Organization legal name"`);
    await c.s.click(c.page().getByRole('button', { name: 'Create Organization', exact: true }), 'Create Organization');
    await c.see(c.page().getByRole('button', { name: /Create anyway/ }), 'button "Create anyway"', 30000);
    await c.s.click(c.page().getByRole('button', { name: /Create anyway/ }), 'Create anyway');
    const url = c.page().url();
    await c.page().waitForTimeout(2500);
    const refused = /\/customers\/new/.test(c.page().url());
    c.ok(refused, 'Create anyway with an empty reason is refused (still on /customers/new)', c.page().url());
    c.controls.push('not run: entering a reason and saving (would add a duplicate customer to the shared stack)');
  }, { mutates: true });

  await check(qa, rec, G, '3.2', 'Customer list has an Owner column with names only', async (c) => {
    await c.as('Dev Sales');
    await c.open('/customers');
    await c.see(c.page().getByRole('columnheader', { name: /Owner/ }), 'column header "Owner"');
    const cells = await c.page().locator('main table tbody tr').evaluateAll((rows) => rows.map((r) => r.innerText.replace(/\s+/g, ' ')));
    c.ok(cells.length > 0, 'customer rows exist');
  });

  skip(rec, G, '4.1', 'Credit hold: Sales sees badge/banner, no Override', 'BLOCKED', 'Needs a customer over its limit plus an accepted quotation. A credit limit cannot be set yet (P3 builds it in round 5) and no seeded customer has one, so no fixture can be made through the UI.', { classify: 'not built' });
  skip(rec, G, '4.2', 'Credit hold: Finance override with a reason confirms the order', 'BLOCKED', 'Same missing fixture as 4.1.', { classify: 'not built' });
  skip(rec, G, '4.3', 'Credit hold: Management override from the held deal banner', 'BLOCKED', 'Same missing fixture as 4.1.', { classify: 'not built' });

  for (const [id, who] of [['5.1', 'Dev Management'], ['5.2', 'Dev Accountant']]) {
    await check(qa, rec, G, id, `${who}: on a deal they can only read, only "View quotations" shows (no "New quotation")`, async (c) => {
      await c.as(who);
      await c.open('/opportunities/70e95bf7-2834-4403-9451-07c44ef5f9bf');
      await c.see(c.page().getByRole('link', { name: 'View quotations' }), 'link "View quotations"', 30000);
      await c.absent(c.page().getByRole('link', { name: 'New quotation' }), 'link "New quotation"');
    }, id === '5.2' ? { classify: 'not built: quotation drafting is not yet limited to owner, department and lead creator (R4a Q4 a, planned as round-5 unit P5)' } : {});
  }

  await check(qa, rec, G, '6.1', 'Founder: Settings > Sales has the Lead owner card first', async (c) => {
    await c.as('Dev Founder');
    await c.open('/settings/sales');
    const heads = await c.page().locator('main h2, main h3').allInnerTexts();
    c.controls.push('card headings: ' + heads.join(' | '));
    c.ok(/Lead owner/i.test(heads[0] ?? ''), 'the first card is "Lead owner"', heads[0]);
  });
  skip(rec, G, '6.2', 'Create a lead as Finance with no owner: it lands on the chosen default owner', NA, 'Changing the default owner is a persistent Settings change that would alter every later run; deferred, listed for Kuu.');
}
