import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { expect, type Page } from '@playwright/test';

/**
 * Steps the QA fixture specs (p4/qa-fixtures-*.spec.ts) share. A fixture acts as a real persona through the same
 * screens a person uses; nothing here writes to the database.
 */

/**
 * Approves the waiting request whose inbox row mentions `needle` (the draft's short id, a reference) as the signed-in
 * persona. The request is created in the submitting transaction, so the reload loop only covers a slow read.
 */
export async function approveInboxRequest(
  page: Page,
  needle: string | RegExp,
  comment: string,
): Promise<void> {
  await page.goto('/inbox');
  const row = page
    .getByRole('table', { name: 'Waiting approvals' })
    .getByRole('row')
    .filter({ hasText: needle });
  await expect(async () => {
    await page.reload();
    await expect(row.first()).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await row.first().getByRole('link').first().click();
  await page.waitForURL(/\/inbox\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve request' });
  await dialog.getByPlaceholder('Anything the requester should know').fill(comment);
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForURL(/\/inbox\?decided=approve/, { timeout: 30_000 });
  await expect(page.getByText('Your approval was recorded.')).toBeVisible();
}

/** The id in the current `/<section>/<uuid>` path. */
export function idFromUrl(page: Page): string {
  const id = /\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/.exec(
    page.url(),
  )?.[1];
  if (id === undefined) throw new Error(`No id in ${page.url()}`);
  return id;
}

/**
 * Where fixtures leave the ids of what they made, for .github/qa/export-ids.sh (git-ignored, with the sign-in states).
 * Ids only. Read, merged and written back, so a later fixture file adds keys without losing earlier ones.
 */
export function recordFixtureIds(add: Record<string, string | string[]>): void {
  const file = path.resolve(process.cwd(), '../../.dev/qa-fixture-ids.json');
  mkdirSync(path.dirname(file), { recursive: true });
  let known: Record<string, string | string[]> = {};
  try {
    known = JSON.parse(readFileSync(file, 'utf8')) as Record<string, string | string[]>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  writeFileSync(file, JSON.stringify({ ...known, ...add }, null, 2));
}

/** Picks a record in a search-as-you-type combobox: types `search`, clicks the first option that shows `optionText`. */
export async function pickFromCombobox(
  page: Page,
  label: string,
  search: string,
  optionText: string,
): Promise<void> {
  const box = page.getByRole('combobox', { name: label, exact: true });
  await box.click();
  await box.fill(search);
  await page.getByRole('option').filter({ hasText: optionText }).first().click();
}
