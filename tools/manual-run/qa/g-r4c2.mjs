// Guide: round4/guide/r4c2.html (portal and documents)
import { check, skip } from './harness.mjs';

export async function run(qa, rec, shared) {
  const G = 'r4c2';
  const NA = 'NOT-RUN';
  skip(rec, G, '1', 'Preparing PDF: issue an invoice, open View PDF at once -> "Preparing PDF", then the PDF appears by itself', NA, 'Issues an invoice on the shared stack; deferred to the mutating pass.');
  skip(rec, G, '2', 'Given up + Retry: stop Gotenberg, wait ~7 min', 'BLOCKED', 'The guide itself forbids this on bos-testrun-* (it needs a throwaway stack with Gotenberg stopped); this run may not stop containers.');
  skip(rec, G, '3', 'Download while preparing: toast in workspace, sentence in portal', NA, 'Needs a PDF that is still rendering (issue an invoice and download at once); deferred with 1.');
  skip(rec, G, '4', 'Blob download file name under the app CSP (Chromium, Firefox)', NA, 'Needs a rendered PDF download in two browsers; only Chromium is installed for this driver, and Firefox is not.');
  await check(qa, rec, G, '5', 'Customer picture: 76 px avatar with centred initials; Founder can change it, a read-only role cannot', async (c) => {
    await c.as('Dev Founder');
    await c.open('/customers/ad04c309-974f-462c-a882-f66f8296bf7a');
    await c.page().waitForTimeout(2500);
    const geo = await c.page().locator('main span').evaluateAll((els) => els.filter((e) => Math.round(e.getBoundingClientRect().width) === 76 && Math.round(e.getBoundingClientRect().height) === 76).map((e) => ({ txt: e.innerText.trim(), cx: Math.round(e.getBoundingClientRect().left + e.getBoundingClientRect().width / 2) })));
    c.controls.push('76x76 avatar spans: ' + JSON.stringify(geo));
    c.ok(geo.length >= 1, 'a 76 px avatar with initials exists on the customer page', JSON.stringify(geo));
    const interactive = await c.page().locator('main span').evaluateAll((els) => els.filter((e) => Math.round(e.getBoundingClientRect().width) === 76).map((e) => !!e.closest('button, label, a') || !!e.parentElement.querySelector('input[type=file]')));
    c.controls.push('avatar is interactive (inside button/label/link or has a file input) for Founder: ' + JSON.stringify(interactive));
    c.ok(interactive.some(Boolean), 'Founder: the avatar is a change-picture control');
    await c.as('Dev Management');
    await c.open('/customers/ad04c309-974f-462c-a882-f66f8296bf7a');
    await c.page().waitForTimeout(2500);
    const ro = await c.page().locator('main span').evaluateAll((els) => els.filter((e) => Math.round(e.getBoundingClientRect().width) === 76).map((e) => !!e.closest('button, label, a') || !!e.parentElement.querySelector('input[type=file]')));
    c.ok(ro.length >= 1 && !ro.some(Boolean), 'read-only role: the avatar is not a change-picture control', JSON.stringify(ro));
  });
  skip(rec, G, '6', 'First portal admin: owner with approved KYB invites a contact (toast, Mailpit)', NA, 'Needs a customer portal owner and a sent invitation (customer sign-in on the portal origin); deferred to the portal pass.');
  skip(rec, G, '7', 'Portal Milestones: portal user opens Milestones, then an order', NA, 'Needs a portal sign-in as Dev Customer; deferred to the portal pass.');
  skip(rec, G, '8', 'Infected file: upload EICAR to a bill / RFQ / sales-order evidence', NA, 'Writes to documents with an EICAR payload on the shared stack. ClamAV is healthy now, so it is runnable; deferred to the mutating pass.');
}
