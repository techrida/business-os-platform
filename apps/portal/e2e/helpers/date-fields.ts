import type { Page } from '@playwright/test';

/**
 * Types an ISO date (`2030-01-15`) into the app's date field by its label, one segment at a time.
 * Pass `time` (`17:00`) for a date-time field; the hour is typed on a 12-hour clock when the field
 * shows an AM/PM segment.
 */
export async function fillDateField(
  page: Page,
  label: string | RegExp,
  iso: string,
  time?: string,
): Promise<void> {
  const [year, month, day] = iso.split('-') as [string, string, string];
  const name = (segment: string) =>
    typeof label === 'string'
      ? new RegExp(`${segment}.*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i')
      : new RegExp(`${segment}.*${label.source}`, label.flags.includes('i') ? 'i' : '');
  for (const [segment, value] of [
    ['month', month],
    ['day', day],
    ['year', year],
  ] as const) {
    await page
      .getByRole('spinbutton', { name: name(segment) })
      .first()
      .pressSequentially(value);
  }
  if (time === undefined) return;
  const [hours, minutes] = time.split(':').map(Number) as [number, number];
  const period = page.getByRole('spinbutton', { name: name('AM/PM') }).first();
  const twelveHour = (await period.count()) > 0;
  const shown = twelveHour ? hours % 12 || 12 : hours;
  await page
    .getByRole('spinbutton', { name: name('hour') })
    .first()
    .pressSequentially(String(shown).padStart(2, '0'));
  await page
    .getByRole('spinbutton', { name: name('minute') })
    .first()
    .pressSequentially(String(minutes).padStart(2, '0'));
  if (twelveHour) await period.pressSequentially(hours >= 12 ? 'PM' : 'AM');
}
