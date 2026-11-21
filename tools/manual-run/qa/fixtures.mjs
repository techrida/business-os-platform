// Records the QA run creates through the real UI (unique names, never an existing record).
export const stamp = () => process.env.QA_STAMP || 'r5qa';

export async function createLead(c, title) {
  const { s } = c;
  await s.goto('/leads/new', (p) => p.getByRole('textbox', { name: 'Lead title', exact: true }));
  await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await s.fill(s.page.getByRole('textbox', { name: 'Lead title', exact: true }), title);
  await s.choose(s.select(/(^| )Lead source$/), 'Referral');
  await s.fill(
    s.page.getByRole('textbox', { name: 'Company or organization', exact: true }),
    `${title} Co`,
  );
  await s.fill('Contact person', 'QA Contact');
  await s.click(s.button('Create lead'), 'Create lead');
  const landed = await s.page
    .waitForURL(/\/leads\/[0-9a-f-]{36}/, { timeout: 90000 })
    .then(() => true)
    .catch(() => false);
  if (!landed) {
    // A slow server action: find the lead by its exact title (never create it twice).
    await s.goto(`/leads?q=${encodeURIComponent(title)}`, (p) => p.locator('main'));
    const link = s.page.locator('main a[href^="/leads/"]').filter({ hasText: title }).first();
    await link.waitFor({ state: 'visible', timeout: 60000 });
    return (await link.getAttribute('href')).split('?')[0];
  }
  return s.page.url().split('?')[0].replace(s.cfg.appUrl, '');
}

/**
 * Fill every empty required-looking field of the open dialog with QA text, pick the first option of any
 * custom select, then press the dialog's submit button (the last button in the footer unless `name`).
 */
export async function submitDialog(c, name) {
  const { s } = c;
  const d = s.page.getByRole('dialog').last();
  await d.waitFor({ state: 'visible', timeout: 20000 });
  for (const t of await d.locator('button[aria-haspopup="listbox"]').all()) {
    await s.choose(t, /./).catch(() => {});
  }
  for (const f of await d.locator('textarea, input[type=text], input:not([type])').all()) {
    if (!(await f.isEditable().catch(() => false))) continue;
    if ((await f.inputValue()) === '') await f.fill('QA text from the round-5 browser run.');
  }
  const submit = name
    ? d.getByRole('button', { name, exact: true })
    : d
        .getByRole('button')
        .filter({ hasText: /\S/ })
        .filter({ hasNotText: /^(Cancel|Close)$/ })
        .last();
  await submit.click({ delay: 80 });
}

/** Mark lost: the Reason is a combobox (type a reason, pick "Add ..."), the Note is required. */
export async function markLost(c, reason = 'QA lost reason') {
  const { s } = c;
  const p = s.page;
  await s.click(p.getByRole('button', { name: 'Mark lost', exact: true }), 'Mark lost');
  const d = p.getByRole('dialog');
  const cb = d.getByRole('combobox', { name: 'Reason' });
  await cb.click();
  await cb.fill(reason);
  await p.getByRole('option').first().click({ delay: 80 });
  await d.getByRole('textbox', { name: 'Note' }).fill('QA note');
  await d.getByRole('button', { name: 'Mark lost', exact: true }).click({ delay: 80 });
  await p
    .getByText(/Step 5:\s*Lost/)
    .first()
    .waitFor({ state: 'visible', timeout: 30000 });
}
