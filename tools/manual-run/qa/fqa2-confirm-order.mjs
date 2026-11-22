#!/usr/bin/env node
// FQA2 fixture, last staff step: the Founder confirms the Draft sales order of Dev Customer Co's accepted quotation.
// usage: node fqa2-confirm-order.mjs <sales-order-id>
import { openQA, makeCtx } from './harness.mjs';

const id = process.argv[2];
if (!/^[0-9a-f-]{36}$/.test(id ?? ''))
  throw new Error('usage: fqa2-confirm-order.mjs <sales-order-id>');
const qa = await openQA({ label: 'fqa2confirm' });
const c = makeCtx(qa);
const p = qa.s.page;
await c.as('Dev Founder');
await c.open(`/sales-orders/${id}`);
await p.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
await qa.s.click(p.getByRole('button', { name: 'Confirm order', exact: true }), 'Confirm order');
const d = p.getByRole('dialog');
if (await d.isVisible({ timeout: 5000 }).catch(() => false)) {
  console.log('dialog:', (await d.innerText()).slice(0, 300).replace(/\s+/g, ' '));
  await d
    .getByRole('button', { name: /^Confirm/ })
    .last()
    .click();
}
await p
  .getByText('Confirmed', { exact: true })
  .first()
  .waitFor({ state: 'visible', timeout: 60000 });
console.log(
  'order confirmed:',
  /SO-\d{4}\/\d{2}-\d{5}/.exec(await p.locator('main').innerText())?.[0],
);
await qa.browser.close();
