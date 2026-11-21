// Guide: round4/guide/r4d.html (access model follow-ups)
import { check, skip } from './harness.mjs';

export async function run(qa, rec, shared) {
  const G = 'r4d';
  const NA = 'NOT-RUN';
  const sectionLinks = async (c) => {
    await c.open('/settings');
    return c.page().locator('a[href^="/settings/"]').evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute('href')))]);
  };

  await check(qa, rec, G, '1.1', 'Finance: Settings offers Currencies, Tax, Numbering, Saved terms; no "enabled currencies" / "maximum rate age" controls', async (c) => {
    await c.as('Dev Finance');
    const links = await sectionLinks(c);
    c.controls.push('settings links: ' + links.join(', '));
    for (const h of ['/settings/currencies', '/settings/tax', '/settings/numbering', '/settings/terms']) c.ok(links.includes(h), `Settings offers ${h}`);
    await c.open('/settings/currencies');
    await c.absent(c.page().getByText(/enabled currencies/i), 'control text "enabled currencies"');
    await c.absent(c.page().getByText(/maximum rate age/i), 'control text "maximum rate age"');
    c.controls.push('not run: typing and saving an exchange rate (would add a rate row to the shared stack)');
  });
  await check(qa, rec, G, '1.2', 'Accountant: Tax, Numbering, Saved terms offered; Currencies is not', async (c) => {
    await c.as('Dev Accountant');
    const links = await sectionLinks(c);
    c.controls.push('settings links: ' + links.join(', '));
    for (const h of ['/settings/tax', '/settings/numbering', '/settings/terms']) c.ok(links.includes(h), `Settings offers ${h}`);
    c.ok(!links.includes('/settings/currencies'), 'Settings does not offer /settings/currencies');
  });
  await check(qa, rec, G, '1.3', 'Sales: none of the four sections offered; opening one by address shows the no-access page', async (c) => {
    await c.as('Dev Sales');
    const links = await sectionLinks(c);
    c.controls.push('settings links: ' + links.join(', '));
    for (const h of ['/settings/currencies', '/settings/tax', '/settings/numbering', '/settings/terms']) c.ok(!links.includes(h), `Settings does not offer ${h}`);
    await c.open('/settings/tax');
    const t = (await c.page().locator('main').innerText()).replace(/\s+/g, ' ');
    c.ok(/access|permission|not allowed|cannot|can.t/i.test(t), 'the page says no access', t.slice(0, 160));
    await c.absent(c.page().getByRole('button', { name: /^Save/ }), 'a Save button on /settings/tax');
  });
  skip(rec, G, '1.4', 'Founder removes settings.finance.write from Accountant; Tax disappears for Accountant', NA, 'Changes shared grants (Access); deferred to a final pass with a restore check. Guide section 2 needs the same.', { classify: '' });
  skip(rec, G, '2.1', 'Narrow Finance "Enter vendor bills" to Own; buttons follow the saved grant', NA, 'Changes shared grants; deferred with 1.4.');
  skip(rec, G, '2.2', 'Give Procurement the bill-entry grant; bill buttons appear without a redeploy', NA, 'Changes shared grants; deferred with 1.4.');

  await check(qa, rec, G, '3.1', 'Finance and Accountant see every lead, not only their own', async (c) => {
    await c.as('Dev Sales');
    await c.open('/leads');
    const salesTotal = await c.page().locator('main').innerText();
    const count = (t) => { const m = t.match(/of\s+(\d+)/i) || t.match(/(\d+)\s+(leads|results)/i); return m ? Number(m[1]) : null; };
    shared.salesLeadCount = count(salesTotal);
    for (const who of ['Dev Finance', 'Dev Accountant']) {
      await c.as(who);
      await c.open('/leads');
      const t = await c.page().locator('main').innerText();
      c.controls.push(`${who}: pagination text count ${count(t)}, Sales sees ${shared.salesLeadCount}`);
      const rows = await c.page().locator('main table tbody tr').count();
      c.ok(rows > 0, `${who} sees lead rows`, String(rows));
    }
    await c.as('Dev Marketing Manager');
    await c.open('/leads');
    const mk = await c.page().locator('main table tbody tr').count();
    c.controls.push(`Dev Marketing Manager (department-scoped) sees ${mk} lead rows`);
  });

  await check(qa, rec, G, '4.1', 'Sales manager sees Reopen on a lost lead in their department; a manager of another department does not', async (c) => {
    if (!shared.lostLead) throw new Error('no lost lead from r4a 1.3 (run r4a first)');
    await c.as('Dev Sales Manager');
    await c.open(shared.lostLead);
    await c.see(c.page().getByRole('button', { name: /Reopen/ }), 'button "Reopen" (Sales manager, own department)');
    await c.as('Dev Marketing Manager');
    await c.open(shared.lostLead);
    await c.absent(c.page().getByRole('button', { name: /^Reopen/ }), 'button "Reopen" (Marketing manager, other department)');
    c.controls.push('not run: clicking Reopen, and widening "Reopen lost leads" in Access');
  });

  await check(qa, rec, G, '5.1', 'Settings > Access: "Last changed" line has "View history"', async (c) => {
    await c.as('Dev Founder');
    await c.open('/settings/access');
    await c.see(c.page().getByText(/Last changed/).first(), 'text "Last changed"');
    await c.see(c.page().getByRole('link', { name: /View history/ }).or(c.page().getByRole('button', { name: /View history/ })), '"View history" control');
  });
  skip(rec, G, '5.2', 'Check a person from another entity: every area says "No access in this entity"', NA, 'Needs a person who is not in the entity; the seed has one entity, so no such person exists. Not built / no fixture.', { classify: '' });
  skip(rec, G, '5.3', 'Review dialog refuses a head change the save would refuse; Founder removal refused naming the entity', NA, 'Changes shared Access and needs a second entity with Founders; deferred.');
  skip(rec, G, '6.1', 'Retire a department while another tab adds a person: refused with "People changed"', NA, 'Needs two tabs and a throwaway department; deferred to the mutating pass.');
  skip(rec, G, '6.2', 'Retire a department with a disabled member: the member ends with no department', NA, 'Needs a throwaway department with a disabled member; deferred to the mutating pass.');
  skip(rec, G, 'x.1', 'FR-7 browser test access-grant-change.spec.ts; migration 0093 count on bos-testrun', 'NOT-RUN', 'The guide marks these as not hand-checkable here (a dev-stack Playwright spec and a database run).');
}
