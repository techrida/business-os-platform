import { expect, test, type Locator, type Page, type Request } from '@playwright/test';

import { persona } from '../helpers/personas';
import { chooseOption, selectByLabel } from '../helpers/select';

/**
 * FR-7: the Founder changes one grant in Settings > Access, confirms the warning, saves, and the change shows up
 * in Check a person; the grant is put back afterwards. Accounts are switched with the Dev menu (real sessions, no
 * password typed), so the Workspace must run under `next dev`.
 *
 * The grant is the Sales role's "See leads". Widening it to Everything raises the W5 "will see every lead"
 * confirmation for a role with active people (the seeded Sales persona). The access revision is not shown on the
 * screen: each save sends the revision the page loaded, so the restoring save carrying a different revision than
 * the first proves the first save moved it and the page picked up the new one.
 */
test.skip(
  process.env.BOS_E2E_NEXT_DEV !== '1',
  'needs the Workspace running under `next dev`; set BOS_E2E_NEXT_DEV=1',
);

const ROLE_PAGE = '/settings/access/roles/sales';
const GRANT_LABEL = 'See leads';
const WIDE = 'Everything';

interface WhoAmI {
  userId: string;
  roles: string[];
}

/** The signed-in account, or no roles while a switch is still redirecting (so a poll keeps trying). */
async function whoami(page: Page): Promise<WhoAmI> {
  try {
    return await page.evaluate(async () => {
      const response = await fetch('/dev/api/whoami', { cache: 'no-store' });
      if (!response.ok) return { userId: '', roles: [] };
      return (await response.json()) as WhoAmI;
    });
  } catch {
    return { userId: '', roles: [] };
  }
}

/** Switches account from the floating Dev menu's Accounts list, then waits for the new session. */
async function switchWithDevMenu(page: Page, label: string, role: string): Promise<WhoAmI> {
  await page.getByRole('button', { name: 'Dev menu', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Dev tools', exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: label, exact: true }).click();
  await expect.poll(async () => (await whoami(page)).roles).toContain(role);
  return whoami(page);
}

/** The reach shown on the grant's dropdown, e.g. "Their own". */
async function shownReach(trigger: Locator): Promise<string> {
  return (await trigger.innerText()).trim();
}

const exactly = (text: string): RegExp =>
  new RegExp(`^\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);

/** The save request (the only access action that carries `acknowledged`) and the revision it sent. */
function isSave(request: Request): boolean {
  return (
    request.method() === 'POST' &&
    request.headers()['next-action'] !== undefined &&
    (request.postData() ?? '').includes('"acknowledged"')
  );
}

function revisionOf(request: Request): string {
  const match = /"expectedRevision":"([^"]+)"/.exec(request.postData() ?? '');
  if (!match?.[1]) throw new Error('The save did not send an expected revision');
  return match[1];
}

/**
 * Sets the grant to the option labelled `reach`, reviews, ticks every confirm warning, saves, and returns the
 * revision the save was made against.
 */
async function saveReach(page: Page, reach: string, expectWarning: RegExp | null): Promise<string> {
  await page.goto(ROLE_PAGE);
  const trigger = selectByLabel(page, GRANT_LABEL);
  await expect(trigger).toBeVisible();
  await chooseOption(trigger, { label: exactly(reach) });
  await expect.poll(() => shownReach(trigger)).toBe(reach);

  await page.getByRole('button', { name: 'Review changes', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const save = dialog.getByRole('button', { name: 'Save changes', exact: true });
  if (expectWarning !== null) {
    const confirm = dialog.getByRole('checkbox', { name: expectWarning });
    await expect(confirm).toBeVisible();
    // A confirm warning holds Save until it is ticked.
    await expect(save).toBeDisabled();
  }
  for (const box of await dialog.getByRole('checkbox', { name: /^I understand:/ }).all()) {
    await box.check();
  }
  await expect(save).toBeEnabled();
  const sent = page.waitForRequest(isSave);
  await save.click();
  const revision = revisionOf(await sent);
  await expect(dialog).toBeHidden();
  await expect.poll(() => shownReach(selectByLabel(page, GRANT_LABEL))).toBe(reach);
  return revision;
}

/**
 * The person's own id for the Check a person address (`app.users.id`). The Dev menu's who-am-I gives the identity
 * provider's id, which that page refuses, so the person is chosen in the page's own picker and the id is read from
 * the address it navigates to.
 */
async function checkPersonId(page: Page, name: string): Promise<string> {
  await page.goto('/settings/access/check');
  const box = page.getByRole('combobox', { name: 'Person', exact: true });
  await box.click();
  await box.fill(name);
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page
    .getByRole('option')
    .filter({ has: page.getByText(new RegExp(`^${escaped}(?: \\(.+\\))?$`)) })
    .click();
  await expect(page).toHaveURL(/[?&]person=[0-9a-f-]{36}/i);
  return new URL(page.url()).searchParams.get('person') ?? '';
}

/**
 * The reach in the "Can see" cell of the Leads row in Check a person: its first span, without the count or the "was ..." note
 * the page adds after a recent change.
 */
async function leadsCanSee(page: Page, personId: string): Promise<string> {
  await page.goto(`/settings/access/check?person=${encodeURIComponent(personId)}`);
  const row = page
    .getByRole('table')
    .getByRole('row')
    .filter({ has: page.getByRole('rowheader', { name: 'Leads', exact: true }) });
  await expect(row).toHaveCount(1);
  // The first line only: the cell may add a count underneath ("0 of 0").
  return (await row.getByRole('cell').first().locator('span').first().innerText())
    .trim()
    .split('\n')[0]!
    .trim();
}

test('the Founder changes a grant, confirms the warning, saves, and Check a person shows it', async ({
  page,
}) => {
  // Two saves and two polls that wait out the grant cache.
  test.setTimeout(240_000);
  const sales = persona('sales');
  const founder = persona('founder');

  // A first session through the Dev switcher page, then the Founder through the Dev menu.
  await page.goto('/dev/personas');
  await page.getByRole('button', { name: sales.label, exact: true }).click();
  await expect.poll(async () => (await whoami(page)).roles).toContain(sales.role);
  const salesUser = await whoami(page);
  expect(salesUser.userId).not.toBe('');
  await page.goto('/');
  await switchWithDevMenu(page, founder.label, founder.role);

  await page.goto('/settings/access');
  await expect(page.getByRole('heading', { name: 'Access', exact: true })).toBeVisible();

  await page.goto(ROLE_PAGE);
  const original = await shownReach(selectByLabel(page, GRANT_LABEL));
  expect(original, 'the Sales role must not already see every lead').not.toBe(WIDE);
  const salesPersonId = await checkPersonId(page, sales.label);
  const before = await leadsCanSee(page, salesPersonId);
  expect(before).not.toBe(WIDE);

  // Saved grants reach the person's next request; the polls allow for the grant cache.
  const settle = { timeout: 75_000, intervals: [2_000] };
  let changed = false;
  try {
    let firstRevision = '';
    await test.step('widen See leads for Sales and confirm the warning', async () => {
      firstRevision = await saveReach(page, WIDE, /will see every lead/);
      changed = true;
    });

    await test.step('Check a person shows the wider reach', async () => {
      await expect.poll(() => leadsCanSee(page, salesPersonId), settle).toBe(WIDE);
    });

    await test.step('restore the grant against the new revision', async () => {
      const restoreRevision = await saveReach(page, original, null);
      changed = false;
      expect(restoreRevision).not.toBe(firstRevision);
      await expect.poll(() => leadsCanSee(page, salesPersonId), settle).toBe(before);
    });
  } finally {
    if (changed) await saveReach(page, original, null);
  }
});
