import { expect, test } from '@playwright/test';

// Runs on the `prod` project: a production build of the Workspace. The persona switcher lists
// logins for seeded users, so it must not exist here (risk R12). This test needs no ZITADEL.
test('the dev persona switcher is a 404 in a production build', async ({ page }) => {
  const response = await page.goto('/dev/personas');
  expect(response?.status()).toBe(404);
  // A 404 status with the page's markup behind it would still be a leak.
  expect(await page.content()).not.toContain('BOS_DEV_PERSONA_SWITCHER');
});

test('other /dev paths are 404 as well', async ({ page }) => {
  for (const path of ['/dev', '/dev/personas/', '/dev/anything']) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
  }
});
