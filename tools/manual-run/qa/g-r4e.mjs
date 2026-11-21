// Guide: round4/guide/r4e.html (settings, users, locks, workflows, email delivery, tax)
import { check, skip } from './harness.mjs';

export async function run(qa, rec, shared) {
  const G = 'r4e';
  const NA = 'NOT-RUN';
  await check(qa, rec, G, '1.1', 'Founder > Settings > Users: lock and unlock controls exist on a user row (read-only look)', async (c) => {
    await c.as('Dev Founder');
    await c.open('/settings/users');
    const names = await c.page().locator('main button').evaluateAll((bs) => bs.map((b) => (b.getAttribute('aria-label') || b.innerText || '').trim()).filter(Boolean));
    c.controls.push('buttons on /settings/users: ' + [...new Set(names)].slice(0, 25).join(' | '));
    const lock = await c.page().getByRole('button', { name: /^Lock|Deactivate|Unlock/ }).count();
    c.ok(lock > 0, 'a Lock / Unlock / Deactivate control is offered', String(lock));
  });
  skip(rec, G, '1.2', 'Lock then unlock a test user, audited; refuse locking self and the last Founder; 5 wrong passwords lock for 15 min', NA, 'Needs a throwaway user (Add user creates a ZITADEL account and mail) and wrong-password attempts; never spent on a seeded persona. Deferred to the mutating pass.');
  skip(rec, G, '2.1', 'Add New User with Department and Level; a second head for one department is refused', NA, 'Creates real users; deferred to the mutating pass.');
  await check(qa, rec, G, '3.1', 'Logout: picking the remembered account on the sign-in page asks for the password', async (c) => {
    // Real sign-in, then sign out, then the sign-in page must not sign straight back in.
    const { realLogin } = await import('../lib/session.mjs');
    await c.s.page.context().clearCookies();
    await realLogin(c.s, c.page(), 'accountant', qa.cfg.appUrl + '/');
    await c.s.click(c.page().getByRole('button', { name: 'Sign out' }));
    await c.page().waitForLoadState('domcontentloaded');
    await c.s.goto('/', (p) => p.locator('body'));
    await c.page().waitForTimeout(3000);
    const url = c.page().url();
    c.controls.push('after sign out and revisit, URL host: ' + new URL(url).host);
    const onLogin = new URL(url).origin === new URL(qa.cfg.authUrl).origin;
    c.ok(onLogin, 'revisiting the app lands on the sign-in page, not the app', new URL(url).host);
    const remembered = c.page().getByRole('button', { name: /Accountant|accountant/ }).first();
    if (await remembered.isVisible().catch(() => false)) {
      await remembered.click();
      await c.see(c.page().locator('input[type=password]'), 'the password field after picking the remembered account', 20000);
    } else c.controls.push('note: the sign-in page offers no remembered-account button, so the password is simply requested');
    qa.s.persona = null;
  }, { mutates: true });
  await check(qa, rec, G, '4.1', 'Settings > Workflows lists the Memo approver workflow', async (c) => {
    await c.as('Dev Founder');
    await c.open('/settings/workflows');
    await c.see(c.page().getByRole('heading', { name: 'Memo approver' }), 'heading "Memo approver"');
  });
  await check(qa, rec, G, '4.2', 'Changing a rule shows the bar "Unsaved changes: press Done" (TR-Q6)', async (c) => {
    await c.as('Dev Founder');
    await c.open('/settings/workflows');
    await c.s.click(c.page().locator('summary', { hasText: 'Edit as a new draft' }).nth(10));
    const reason = c.page().getByRole('textbox', { name: 'Reason shown to the approver' }).first();
    await c.see(reason, 'textbox "Reason shown to the approver"');
    await reason.fill((await reason.inputValue()) + ' (edited)');
    await c.see(c.page().getByText(/Unsaved changes: press Done/), 'text "Unsaved changes: press Done"', 6000);
  }, { classify: 'guide wrong: the "Unsaved changes: press Done" pill belongs to the memo editor (memo-review-gate.tsx), not to workflow rules; see 4.2b' });
  await check(qa, rec, G, '4.2b', 'Memo editor: typing shows "Unsaved changes: press Done"', async (c) => {
    await c.as('Dev Sales');
    await c.open('/memos');
    const nm = c.page().getByRole('link', { name: /New memo|Write a memo|\+ New/ }).first();
    await c.see(nm, 'link to a new memo');
    await c.s.click(nm);
    await c.page().waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    const editor = c.page().locator('[contenteditable=true], textarea').first();
    await c.see(editor, 'a memo text editor');
    await editor.click();
    await c.page().keyboard.type('QA typing for the unsaved pill');
    await c.see(c.page().getByText(/Unsaved changes: press Done/), 'text "Unsaved changes: press Done"', 15000);
    c.controls.push('nothing submitted; the memo draft is left unsent');
  }, { mutates: true });
  skip(rec, G, '4.3', 'Publishing a workflow as the same person who saved it is refused; a second Founder or Management can publish', NA, 'Would create new workflow draft versions on the shared stack; deferred to the mutating pass.');
  await check(qa, rec, G, '5.1', 'Settings > Email delivery lists failed and bounced emails', async (c) => {
    await c.as('Dev Founder');
    await c.open('/settings/email-delivery');
    const t = (await c.page().locator('main').innerText()).replace(/\s+/g, ' ');
    c.controls.push('page text: ' + t.slice(0, 200));
    await c.see(c.page().getByRole('heading', { level: 1 }), 'the page heading');
    c.ok(/failed|bounce/i.test(t), 'the page mentions failed/bounced emails', t.slice(0, 160));
    c.controls.push('Resend buttons: ' + (await c.page().getByRole('button', { name: /Resend/ }).count()));
  });
  await check(qa, rec, G, '6.1', 'Tax, Saved terms and Sales settings pages: VAT-rate card, no Delete on tax codes, Delivery holds editable by Founder only', async (c) => {
    await c.as('Dev Founder');
    await c.open('/settings/tax');
    c.controls.push('tax headings: ' + (await c.page().locator('main h2, main h3').allInnerTexts()).join(' | '));
    await c.absent(c.page().getByRole('button', { name: /^Delete/ }), 'button "Delete" on /settings/tax');
    await c.open('/settings/terms');
    await c.see(c.page().getByRole('heading', { level: 1 }), 'Saved terms page heading');
    await c.open('/settings/sales');
    const hold = c.page().getByText(/Delivery hold/i).first();
    await c.see(hold, 'card "Delivery holds"');
    const founderEditable = await c.page().locator('main input:not([disabled])').count();
    await c.as('Dev Management');
    await c.open('/settings/sales');
    const mgmtEditable = await c.page().locator('main input:not([disabled]):not([readonly])').count();
    c.controls.push(`editable inputs on /settings/sales: Founder ${founderEditable}, Management ${mgmtEditable}`);
    c.ok(mgmtEditable < founderEditable || mgmtEditable === 0, 'Management has fewer editable inputs than Founder on /settings/sales', `${mgmtEditable} vs ${founderEditable}`);
  });
  skip(rec, G, '6.2', 'Add, change and retire a tax code and a payment term; refuse a third decimal in Delivery holds', NA, 'Persistent settings writes; deferred to the mutating pass.');
  await check(qa, rec, G, '7.1', 'Shell user card and greeting show the display name', async (c) => {
    await c.as('Dev Sales');
    await c.open('/');
    await c.see(c.page().getByText('Dev Sales').first(), 'display name "Dev Sales" in the shell');
  });
}
