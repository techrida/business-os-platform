// Mutating pass: additive checks that create throwaway records (unique "QA r5" names). Guide r4e sections 1-2.
import { check, skip } from './harness.mjs';

export async function run(qa, rec, shared) {
  const G = 'r4e';
  const tag = Date.now().toString(36);
  // Fixture for the FG-Q2 dialog capture: bring the on-hold qualified lead back to Qualified.
  if (process.env.QA_RESUME_QLEAD && shared.qLead) {
    const { makeCtx } = await import('./harness.mjs');
    const c0 = makeCtx(qa, rec);
    await c0.as('Dev Sales');
    await c0.open(shared.qLead);
    await c0.s.click(c0.page().getByRole('button', { name: 'Resume', exact: true }));
    await c0
      .page()
      .getByRole('dialog')
      .getByRole('button', { name: 'Resume lead', exact: true })
      .click({ delay: 80 });
    await c0
      .page()
      .getByRole('button', { name: 'Convert to opportunity' })
      .waitFor({ state: 'visible', timeout: 45000 });
    console.log('qLead resumed to Qualified');
    shared.newLead = '/leads/18f79d98-1cc2-4964-bc36-1c6ca0859f29';
    shared.save();
  }
  const invite = async (c, { first, last, mail, dept, level, role }) => {
    await c.open('/settings/users/new');
    await c.s.fill(c.page().getByRole('textbox', { name: 'First name', exact: true }), first);
    await c.s.fill(c.page().getByRole('textbox', { name: 'Last name', exact: true }), last);
    await c.s.fill(c.page().getByRole('textbox', { name: 'Work email', exact: true }), mail);
    if (dept)
      await c.s.choose(/Department$/, dept).catch(async () => c.s.choose('Department', dept));
    if (level) await c.s.choose(/Level$/, level).catch(async () => c.s.choose('Level', level));
    await c.page().getByRole('checkbox', { name: role, exact: true }).check();
    await c.s.click(
      c.page().getByRole('button', { name: 'Send invitation', exact: true }),
      'Send invitation',
    );
  };
  await check(
    qa,
    rec,
    G,
    '2.1',
    'Add user with Department and Level: a second head for one department is refused with a clear message',
    async (c) => {
      await c.as('Dev Founder');
      await invite(c, {
        first: 'QA',
        last: `Head ${tag}`,
        mail: `qa-r5-head-${tag}@bos-demo.example.com`,
        dept: 'Sales',
        level: 'Head of department',
        role: 'Sales',
      });
      await c.page().waitForTimeout(4000);
      const t = (await c.page().locator('main').innerText()).replace(/\s+/g, ' ');
      c.controls.push('page text after submit: ' + t.slice(0, 220));
      c.ok(
        /head/i.test(t) && /already|only one|second|one head/i.test(t),
        'a message says the department already has a head',
        t.slice(0, 200),
      );
    },
    { mutates: true },
  );
  shared.qaTag ||= 'mwpz3ytn'; // the user already invited by the first attempt (the form clears and stays open after a successful invite)
  await check(
    qa,
    rec,
    G,
    '2.2',
    'Add user with Department and Level (Staff in Sales) is accepted and listed as invited',
    async (c) => {
      await c.as('Dev Founder');
      if (!shared.qaInvited) {
        await invite(c, {
          first: 'QA',
          last: `Staff ${shared.qaTag}`,
          mail: `qa-r5-${shared.qaTag}@bos-demo.example.com`,
          dept: 'Sales',
          level: 'Staff',
          role: 'Sales',
        });
        await c.page().waitForTimeout(5000);
        shared.qaInvited = true;
        shared.save();
      }
      await c.s.goto(`/settings/users?q=${encodeURIComponent('Staff ' + shared.qaTag)}`, (p) =>
        p.locator('main'),
      );
      await c.see(
        c.page().getByText(`Staff ${shared.qaTag}`).first(),
        `row for "QA Staff ${shared.qaTag}"`,
        30000,
      );
      const row = c
        .page()
        .locator('main table tbody tr', { hasText: `Staff ${shared.qaTag}` })
        .first();
      c.controls.push('row text: ' + (await row.innerText()).replace(/\s+/g, ' ').slice(0, 160));
      shared.qaUser = `Staff ${shared.qaTag}`;
      shared.save();
    },
    { mutates: true },
  );
  await check(
    qa,
    rec,
    G,
    '1.2a',
    "Users: the Founder's own row offers no enabled Lock or Deactivate (self-lock refused)",
    async (c) => {
      await c.as('Dev Founder');
      await c.s.goto('/settings/users?q=Dev%20Founder', (p) => p.locator('main'));
      const mine = c.page().locator('main table tbody tr', { hasText: 'Dev Founder' }).first();
      await c.see(mine, 'own row (Dev Founder)');
      const all = await mine.getByRole('button').evaluateAll((els) =>
        els.map((e) => ({
          t: (e.innerText || e.getAttribute('aria-label') || '').trim(),
          disabled: e.disabled,
        })),
      );
      c.controls.push('own-row buttons: ' + JSON.stringify(all));
      const risky = all.filter((b) => /^(Lock|Deactivate)/.test(b.t));
      c.ok(
        risky.every((b) => b.disabled),
        'no enabled Lock/Deactivate on the own row',
        JSON.stringify(risky),
      );
    },
  );
  skip(
    rec,
    G,
    '1.2b',
    'Lock then unlock a throwaway user (audited); last Founder refused; 5 wrong passwords lock for 15 min',
    'BLOCKED',
    'The throwaway user created by this run is only invited: its row offers no Lock button (row buttons: none) until the invitation is accepted through the invite mail (Mailpit) and a password set. Accepting an invitation needs the ZITADEL set-password flow; not scripted. Lock/unlock buttons were seen on active users on /settings/users (r4e 1.1).',
  );
}
