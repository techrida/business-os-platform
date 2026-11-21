// Guide: round4/guide/r4f.html (procurement)
import { check, skip } from './harness.mjs';

export async function run(qa, rec) {
  const G = 'r4f';
  const NA = 'NOT-RUN';
  const poLink = async (c, list = '/procurement/orders') => {
    await c.open(list);
    return (
      await c
        .page()
        .locator('main a[href^="/procurement/orders/"]')
        .evaluateAll((as) => as.map((a) => a.getAttribute('href').split('?')[0]))
    ).find((h) => h.split('/').length === 4);
  };
  await check(
    qa,
    rec,
    G,
    '6.1',
    'Accountant, Finance, Warehouse see "Purchase orders" in the menu and open a PO with no edit buttons',
    async (c) => {
      for (const who of ['Dev Accountant', 'Dev Finance', 'Dev Warehouse']) {
        await c.as(who);
        await c.open('/');
        await c.see(
          c.page().getByRole('link', { name: 'Purchase orders', exact: true }),
          `${who}: menu link "Purchase orders"`,
        );
        const po = await poLink(c);
        c.ok(!!po, `${who}: a PO is listed`);
        await c.open(po);
        for (const n of [/^Edit/, /^Amend/, /^Send/, /^Cancel/])
          await c.absent(c.page().getByRole('button', { name: n }), `${who}: button ${n}`);
        if (who === 'Dev Accountant')
          await c.see(
            c
              .page()
              .getByRole('button', { name: /Enter bill/ })
              .or(c.page().getByRole('link', { name: /Enter bill/ })),
            'Accountant: "Enter bill"',
          );
      }
    },
  );
  await check(
    qa,
    rec,
    G,
    '5.1',
    'Warehouse receiving page lists "Recently received" finished orders',
    async (c) => {
      await c.as('Dev Warehouse');
      await c.open('/procurement/receipts');
      c.controls.push(
        'headings: ' + (await c.page().locator('main h1, main h2').allInnerTexts()).join(' | '),
      );
      await c.see(
        c
          .page()
          .getByText(/Recently received/i)
          .first(),
        'text "Recently received"',
      );
    },
  );
  skip(
    rec,
    G,
    '8.1',
    'RFQ header shows "Extend deadline"',
    'BLOCKED',
    'Extend deadline only shows on an RFQ in status Open (code: canExtendDeadline). The stack has one RFQ (RFQ-2083/84-00001), already Recommended with its PR at po_issued, so there is no Open RFQ. Needs a new RFQ from PR-2083/84-00001 or -00002 (dept_approved); see the mutating pass.',
  );
  await check(
    qa,
    rec,
    G,
    '9.1',
    'A Recommended RFQ shows "Submit for commitment approval" in the header (only while its purchase request is at Sourcing)',
    async (c) => {
      await c.as('Dev Procurement');
      await c.open('/procurement/rfqs/d6c7b6d2-d56f-4a74-b305-56fb0f202fe1');
      await c.see(c.page().getByText('Recommended').first(), 'status "Recommended"');
      await c.see(
        c.page().getByRole('button', { name: /Submit for commitment approval/ }),
        'button "Submit for commitment approval"',
        8000,
      );
    },
    {
      classify:
        "guide wrong: the button needs the PR at Sourcing; this RFQ's PR is already po_issued, so hiding it is correct (precondition not met, see the BLOCKED note)",
    },
  );
  for (const [id, t, why] of [
    [
      '1.1',
      'Over-receipt: plain sentence "ask Procurement to amend the purchase order first"',
      'Needs a PO with open quantity and a receipt that over-receives; writes receipts. Deferred to the mutating pass.',
    ],
    [
      '2.1',
      'Amendments: total/terms go to approval, description applies at once; vendor change not allowed',
      'Amends a PO and starts approvals; deferred to the mutating pass.',
    ],
    [
      '3.1',
      'Emergency purchase: Management gets one "Emergency review" item (72 h reminder)',
      'Needs an emergency PO fully received; deferred to the mutating pass.',
    ],
    [
      '4.1',
      'Serial numbers: same serial on two receipt lines refused',
      'Needs a serialised receipt draft; deferred to the mutating pass.',
    ],
    [
      '7.1',
      'Read-only buyer sees no Confirm / Discard on a service draft',
      'Needs a service receipt draft; deferred.',
    ],
    [
      '10.1',
      'Switched-off currency wording on PR / RFQ form',
      'Needs a switched-off currency (persistent setting); deferred.',
    ],
    [
      '11.1',
      'Vendor portal bill form starts at today (TR-Q12a)',
      'Needs a vendor portal sign-in; deferred to the portal pass.',
    ],
    [
      '12.1',
      'Payment request: vendor with no bank account is named with what to add',
      'Needs a vendor without a bank account; deferred.',
    ],
    [
      '13.1',
      'KYB: "Send for review" hidden until the case is submitted; stale second tab refused',
      'Needs a vendor KYB case and two tabs; deferred.',
    ],
    [
      '14.1',
      'Duplicates: same vendor name or payment reference warns; tick saves',
      'Creates vendors and payments; deferred to the mutating pass.',
    ],
  ])
    skip(rec, G, id, t, NA, why);
}
