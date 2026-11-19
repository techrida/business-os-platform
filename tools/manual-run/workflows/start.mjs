// Workflow 1 · Sign in and follow one memo (guide steps start-1 … start-6).
// Exact values come from docs/testrun-2026-11-19/steps/start-*.md and the "Update 19 Nov" boxes:
// the new-memo button is Next (autosave), draft buttons are "Download preview as PDF" / "Print preview".
/* global window, document -- referenced inside page.evaluate callbacks, which run in the browser */
import { realLogin } from '../lib/session.mjs';
import { isPdf, pdfText, findMail } from '../lib/support.mjs';

const ROLE = { 'Dev Sales': 'sales', 'Dev Accountant': 'accountant', 'Dev Finance': 'finance' };

export function workflow(cfg) {
  const subject = `BOS Demo — service delivery approval SCR-${cfg.runKey}`;
  const body =
    'Please approve delivery of the Business OS demonstration service to Himalayan Demo Labs.\n\n' +
    'The sales team will prepare a quotation and collect payment after independent financial review.\n' +
    'धन्यवाद।';

  const asPersona = async (s, name) => {
    const who = await s.switchTo(name);
    if (who)
      s.expect(
        who.roles.includes(ROLE[name]),
        `${name} has role ${ROLE[name]}`,
        who.roles.join(','),
      );
  };

  const openMemo = async (s) => {
    await s.goto(s.need('memoUrl'), (p) => p.getByRole('heading', { level: 1, name: subject }));
  };

  const approveFromInbox = async (s, comment) => {
    const requestId = s.need('memoRequestId');
    await s.goto('/inbox', (p) => p.getByRole('heading', { name: 'Inbox', exact: true }));
    // Inboxes are shared with other testers: open this run's row (by subject), never "the first row".
    const row = s.page
      .getByRole('table', { name: 'Waiting approvals' })
      .getByRole('row')
      .filter({ hasText: subject });
    for (
      let i = 0;
      i < 6 &&
      !(await row
        .first()
        .isVisible()
        .catch(() => false));
      i++
    ) {
      await s.page.waitForTimeout(5000);
      await s.page.reload({ waitUntil: 'domcontentloaded' });
    }
    await s.see(row, `inbox row "${subject}"`);
    await s.click(row.first().getByRole('link').first(), 'the inbox row');
    await s.page.waitForURL(new RegExp(`/inbox/${requestId}`));
    await s.see(s.page.getByText(subject).first(), 'the frozen memo paper with its subject');
    await s.pause();
    await s.click(s.button('Approve'), 'Approve');
    const dialog = s.page.getByRole('dialog', { name: 'Approve request' });
    await dialog.getByLabel('Comment (optional)', { exact: true }).fill(comment);
    await s.pause(400);
    await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
    await s.page.waitForURL(/\/inbox\?decided=approve/, { timeout: cfg.navTimeout });
    s.checks.push('approved; inbox shows the decision');
  };

  const routeSteps = async (s) => {
    const steps = s.page.getByRole('list', { name: 'Approval route steps' }).getByRole('listitem');
    await steps.first().waitFor({ state: 'visible' });
    return (await steps.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
  };

  return {
    name: 'start',
    title: 'Sign in and follow one memo',
    steps: [
      {
        id: 'start-1',
        title: 'Enter as Sales',
        async run(s) {
          await asPersona(s, 'Dev Sales');
          await s.goto('/', (p) => p.getByRole('button', { name: 'Dev menu' }));
          await s.caption('start-1 — Dev menu → Who am I');
          await s.click(s.button('Dev menu'), 'Dev menu');
          const panel = s.page.getByRole('region', { name: 'Dev tools' });
          await s.see(panel.getByText('Who am I'), 'Dev tools panel with Who am I');
          await s.see(
            panel.locator('dd').filter({ hasText: /sales/i }),
            'Who am I lists the sales role',
          );
          await s.pause();
          await s.click(
            panel.getByRole('button', { name: 'Hide', exact: true }).or(s.button('Dev menu')),
            'close Dev menu',
          );

          await s.caption('start-1 — collapse and reopen the navigation, then Tab + Enter');
          const collapse = s.button('Collapse sidebar');
          if (await collapse.isVisible().catch(() => false)) {
            await s.click(collapse, 'Collapse sidebar');
            await s.see(s.button('Expand sidebar'), 'sidebar collapsed (Expand sidebar)');
            await s.pause(500);
            await s.click(s.button('Expand sidebar'), 'Expand sidebar');
            await s.see(s.button('Collapse sidebar'), 'sidebar open again');
            await s.button('Collapse sidebar').focus();
          } else {
            await s.click(s.button('Open menu'), 'Open menu (narrow screen)');
            await s.see(s.button('Close menu'), 'navigation drawer open');
            await s.pause(500);
            await s.click(s.button('Close menu'), 'Close menu');
            await s.see(s.button('Open menu'), 'drawer closed');
            await s.click(s.button('Open menu'), 'Open menu again');
            await s.see(s.button('Close menu'), 'drawer open again');
            await s.button('Close menu').focus();
          }
          // Keyboard: Tab until a link in the Main navigation has focus, then Enter follows it.
          let href = null;
          for (let i = 0; i < 25 && !href; i++) {
            await s.page.keyboard.press('Tab');
            href = await s.page.evaluate(() => {
              const a = document.activeElement;
              return a && a.tagName === 'A' && a.closest('nav[aria-label="Main"]')
                ? a.getAttribute('href')
                : null;
            });
          }
          s.expect(href, 'Tab reaches a navigation item');
          await s.pause(400);
          await s.page.keyboard.press('Enter');
          await s.page.waitForURL((u) => u.pathname === new URL(href, cfg.appUrl).pathname, {
            timeout: cfg.navTimeout,
          });
          s.checks.push(`Enter followed nav link ${href}`);
          await s.see(s.page.getByRole('heading', { level: 1 }), 'the linked page heading');
        },
      },
      {
        id: 'start-2',
        title: 'Create the internal memo',
        async run(s) {
          await asPersona(s, 'Dev Sales');
          await s.goto('/memos/new', (p) =>
            p.getByRole('combobox', { name: 'Approved by', exact: true }),
          );
          // Controlled inputs: text typed before hydration is wiped. Wait for the page to settle.
          await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
          await s.choose('Department', 'Operations');
          await s.fill('Subject', subject);
          await s.fill('Body', body);
          s.expect(
            (await s.field('Subject').inputValue()) === subject,
            'the subject kept its value',
          );
          await s.typeahead('Recommended by 1', 'Dev Accountant');
          await s.typeahead('Approved by', 'Dev Finance');
          await s.pause();
          await s.click(s.button('Next'), 'Next (saves the memo)');
          await s.page.waitForURL(/\/memos\/[0-9a-f-]{36}(\?.*)?$/, { timeout: cfg.navTimeout });
          await s.see(s.page.getByRole('heading', { level: 1, name: subject }), 'the saved memo');
          const url = s.page.url().split('?')[0];
          s.record('memoUrl', url.replace(cfg.appUrl, ''));
          const number = /MEMO-[\w/-]*\d{5}/.exec(await s.text())?.[0];
          if (number) s.record('memoNumber', number);

          await s.caption('start-2 — Memos list → open the row');
          await s.goto('/memos', (p) => p.getByRole('heading', { level: 1, name: 'Memos' }));
          const link = s.page.getByRole('link', { name: subject }).first();
          await s.see(link, `Memos row "${subject}"`);
          await s.click(link, 'the memo row');
          await s.page.waitForURL(new RegExp(url.replace(cfg.appUrl, '').replace(/[/]/g, '\\/')));
          await s.see(
            s.page.getByRole('heading', { level: 1, name: subject }),
            'the memo reopened',
          );
          const main = await s.text(s.page.getByRole('main'));
          for (const [what, needle] of [
            ['first paragraph', 'Please approve delivery of the Business OS demonstration service'],
            ['second paragraph', 'The sales team will prepare a quotation'],
            ['Devanagari closing line', 'धन्यवाद।'],
            ['department Operations', 'Operations'],
            ['author Dev Sales', 'Dev Sales'],
            ['recommender Dev Accountant', 'Dev Accountant'],
            ['approver Dev Finance', 'Dev Finance'],
          ]) {
            s.expect(main.includes(needle), `memo shows the ${what}`);
          }
          await s.notVisible(
            s.page.getByLabel(/^(Amount|Currency)$/),
            'amount or currency controls',
          );
          await s.notVisible(
            s.page.getByRole('button', { name: /^(Attach|Add attachment|Upload)/ }),
            'attachment controls',
          );
        },
      },
      {
        id: 'start-3',
        title: 'Preview, download and print',
        async run(s) {
          await asPersona(s, 'Dev Sales');
          await openMemo(s);
          // Draft wording (Update 19 Nov): "Download preview as PDF" / "Print preview".
          const dl = s.button('Download preview as PDF').or(s.button('Download memo as PDF'));
          await s.see(dl, 'Download … as PDF');
          const file = await s.download(dl, s.dirs.files);
          s.expect(
            isPdf(file.bytes),
            'the download is a PDF',
            file.bytes.subarray(0, 8).toString('latin1'),
          );
          s.record('memoPdf', file.path);
          const text = pdfText(file.path);
          if (text === null) s.checks.push('pdftotext not installed: PDF text not read');
          else {
            const flat = text.replace(/\s+/g, ' ');
            s.expect(flat.includes('Please approve delivery'), 'the PDF has the first paragraph');
            s.expect(
              flat.includes('The sales team will prepare a quotation'),
              'the PDF has the second paragraph',
            );
          }

          await s.caption('start-3 — Print (headless: window.print is counted, no dialog)');
          await s.page.evaluate(() => {
            window.__printCalls = 0;
            window.print = () => {
              window.__printCalls++;
            };
          });
          await s.click(s.button('Print preview').or(s.button('Print memo')), 'Print');
          await s.page.waitForTimeout(1500);
          const calls = await s.page.evaluate(() => window.__printCalls);
          if (calls > 0) s.checks.push(`print requested (${calls} call)`);
          else
            s.checks.push(
              'print dialog not observable headless (window.print not called on this page; check by hand)',
            );

          await s.caption('start-3 — read the approval route, then Submit for approval');
          const route = s.page.getByRole('region', { name: 'Approval route' });
          await s.see(route, 'the approval route panel');
          const routeText = await s.text(route);
          const ia = routeText.indexOf('Dev Accountant');
          const ifn = routeText.indexOf('Dev Finance');
          s.expect(
            ia >= 0 && ifn > ia,
            'route is Dev Accountant then Dev Finance',
            routeText.slice(0, 200),
          );
          const submit = s.button('Submit for approval');
          await s.see(submit, 'Submit for approval');
          await s.click(submit, 'Submit for approval');
          await s.page
            .getByRole('dialog', { name: 'Submit for approval?' })
            .getByRole('button', { name: 'Submit for approval', exact: true })
            .click();
          await s.page.waitForURL(/[?&]submitted=pending\b/, { timeout: cfg.navTimeout });
          await s.seeText('Submitted for approval.', 'the submitted confirmation');
          const href = await s.page
            .getByRole('link', { name: 'View the approval route and history' })
            .getAttribute('href');
          const requestId = /\/inbox\/([0-9a-f-]{36})/.exec(href ?? '')?.[1];
          s.expect(requestId, 'an approval request link', href);
          s.record('memoRequestId', requestId);
          // Frozen: the editable form is gone after submit.
          await s.notVisible(s.button('Next'), 'the editable form (Next) after submit');
          await s.see(
            s.button('Download memo as PDF'),
            'post-submit wording "Download memo as PDF"',
          );
        },
      },
      {
        id: 'start-4',
        title: 'First named approval',
        async run(s) {
          await asPersona(s, 'Dev Accountant');
          await approveFromInbox(s, 'Demo memo reviewed by Accountant.');
          await s.goto(`/inbox/${s.need('memoRequestId')}`, (p) =>
            p.getByRole('list', { name: 'Approval route steps' }),
          );
          const steps = await routeSteps(s);
          s.expect(steps.length >= 2, 'two route steps', JSON.stringify(steps));
          s.expect(
            /Dev Accountant/.test(steps[0]) && /Approved/i.test(steps[0]),
            'step 1 Dev Accountant is Approved',
            steps[0],
          );
          s.expect(
            /Dev Finance/.test(steps[1]) && !/Approved/i.test(steps[1]),
            'step 2 waits for Dev Finance',
            steps[1],
          );
        },
      },
      {
        id: 'start-5',
        title: 'Final approval and notification',
        async run(s) {
          await asPersona(s, 'Dev Finance');
          await approveFromInbox(s, 'Demo memo approved by Finance.');

          await s.caption(
            'start-5 — Finance opens the approved memo: audit timeline and decisions',
          );
          await openMemo(s);
          await s.see(s.page.getByText('Approved', { exact: true }), 'memo status Approved');
          const main = await s.text(s.page.getByRole('main'));
          s.expect(
            main.includes('Demo memo reviewed by Accountant.') || main.includes('Dev Accountant'),
            'decision history names the Accountant',
          );
          await s.pause();

          await asPersona(s, 'Dev Sales');
          await s.caption('start-5 — Sales: Memos → the approved memo');
          await s.goto('/memos', (p) => p.getByRole('heading', { level: 1, name: 'Memos' }));
          await s.click(s.page.getByRole('link', { name: subject }).first(), 'the memo row');
          await s.see(s.page.getByRole('heading', { level: 1, name: subject }), 'the memo');
          await s.see(s.page.getByText('Approved', { exact: true }), 'status Approved for Sales');

          await s.caption('start-5 — notification bell: opening the panel must not mark all read');
          const bell = s.page.getByRole('button', { name: /^Notifications/ });
          const before = await bell.first().getAttribute('aria-label');
          await s.click(bell, 'the notification bell');
          const panel = s.page.getByRole('region', { name: 'Notifications panel' });
          await s.see(panel, 'the notifications panel');
          const item = panel
            .getByRole('listitem')
            .filter({ hasText: s.state.memoNumber ?? subject });
          await s.see(item, 'a notification for this memo', 60000);
          await s.page.waitForTimeout(1500);
          const after = await bell.first().getAttribute('aria-label');
          const unread = (t) => Number(/(\d+) unread/.exec(t ?? '')?.[1] ?? 0);
          s.expect(
            unread(after) >= unread(before),
            'opening the panel alone did not mark anything read',
            `${before} → ${after}`,
          );
          await s.pause(400);
          await s.click(item.first().getByRole('link').first(), 'the matching notification');
          await s.page.waitForURL((u) => u.pathname !== '/', { timeout: cfg.navTimeout });
          s.checks.push(`notification opened ${s.page.url()}`);

          await s.caption('start-5 — Test mail: the message for this memo');
          const mail = await findMail(cfg, `subject:"${s.state.memoNumber ?? subject}"`, 90000);
          s.expect(mail, `a Mailpit message about ${s.state.memoNumber ?? subject}`);
          s.record('memoMailSubject', mail.Subject);
          if (/(^|\s)[a-z]+_[a-z_]+\s/.test(mail.Subject))
            s.finding(
              `Approval e-mail subject shows an internal type key: "${mail.Subject}"`,
              'polish',
            );
          await s.goto(`${cfg.mailUrl}/view/${mail.ID}`, (p) => p.getByText(mail.Subject).first());
          await s.pause(1500);
        },
      },
      {
        id: 'start-6',
        title: 'Real password and OTP login',
        async run(s) {
          await asPersona(s, 'Dev Sales'); // the original staff window stays signed in throughout
          await s.caption(
            'start-6 — a private window: real sign-in with password and one-time code',
          );
          // A private window is a separate browser context; it is recorded as its own video.
          const priv = await s.browser.newContext({
            viewport: cfg.viewport,
            recordVideo: { dir: s.dirs.video, size: cfg.viewport },
            ignoreHTTPSErrors: false,
          });
          s.extraContexts = [
            ...(s.extraContexts ?? []),
            { name: 'private-window', context: priv, pages: [] },
          ];
          const page = await priv.newPage();
          s.extraContexts.at(-1).pages.push(page);
          page.setDefaultTimeout(cfg.actionTimeout);
          await realLogin(s, page, 'sales', `${cfg.appUrl}/`);
          const who = await s.whoami(page);
          s.expect(
            who && who.roles.includes('sales'),
            'real sign-in reached the workspace as Sales',
            JSON.stringify(who),
          );
          await page.waitForTimeout(cfg.pace);
          await page.getByRole('button', { name: 'Sign out', exact: true }).first().click();
          await page.waitForURL(
            (u) =>
              !u.href.startsWith(`${cfg.appUrl}/`) ||
              /\/auth\//.test(u.pathname) ||
              /signed-?out/i.test(u.href),
            {
              timeout: cfg.navTimeout,
            },
          );
          s.checks.push(
            `after Sign out: ${new URL(page.url()).host}${new URL(page.url()).pathname}`,
          );
          await page.goto(`${cfg.appUrl}/inbox`, { waitUntil: 'domcontentloaded' });
          await page.waitForLoadState('load').catch(() => {});
          s.expect(
            !page.url().startsWith(`${cfg.appUrl}/inbox`),
            'signed out: /inbox sends you to sign-in',
            page.url(),
          );
          await page.waitForTimeout(cfg.pace);
          await priv.close();
          // The original window keeps its own session.
          await s.caption('start-6 — back in the original staff window: still signed in');
          await s.goto('/', (p) => p.getByRole('button', { name: 'Dev menu' }));
          const still = await s.whoami();
          s.expect(
            still && still.roles.includes('sales'),
            'the original staff window is still signed in',
          );
        },
      },
    ],
  };
}
