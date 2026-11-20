// Workflow 1 · Sign in and follow one memo (guide steps start-1 … start-6).
// Exact values come from docs/testrun-2026-11-19/steps/start-*.md and the "Update 19 Nov" boxes:
// the new-memo button is Next (autosave), draft buttons are "Download preview as PDF" / "Print preview".
/* global window, document, MutationObserver -- referenced inside page.evaluate callbacks, which run in the browser */
import { navLayout, runMatch } from '../lib/config.mjs';
import { realLogin, StepFailure } from '../lib/session.mjs';
import { isPdf, pdfText, findMail } from '../lib/support.mjs';

const ROLE = { 'Dev Sales': 'sales', 'Dev Accountant': 'accountant', 'Dev Finance': 'finance' };

export function workflow(cfg) {
  const subject = `BOS Demo — service delivery approval SCR-${cfg.runKey}`;
  // Finds this run's memo by its subject, never a longer run key that starts with it.
  const mine = runMatch(subject);
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
    await s.goto(s.need('memoUrl'), (p) => p.getByRole('heading', { level: 1, name: mine }));
  };

  const approveFromInbox = async (s, comment) => {
    const requestId = s.need('memoRequestId');
    await s.goto('/inbox', (p) => p.getByRole('heading', { name: 'Inbox', exact: true }));
    // Inboxes are shared with other testers: open this run's row (by subject), never "the first row".
    const row = s.page
      .getByRole('table', { name: 'Waiting approvals' })
      .getByRole('row')
      .filter({ hasText: mine });
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
    await s.see(s.page.getByText(mine).first(), 'the frozen memo paper with its subject');
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
    // The origins whose certificates are checked before launch.
    origins: ['app', 'mail', 'auth'],
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
          // The layout follows the viewport width. A visibility probe on a page that is still
          // settling (dev-server restart) once took the icon-rail branch at 1440.
          const layout = navLayout(cfg.viewport.width);
          if (layout === 'sidebar') {
            const collapse = s.button('Collapse sidebar');
            await s.see(collapse, 'the Collapse sidebar toggle');
            await s.click(collapse, 'Collapse sidebar');
            await s.see(s.button('Expand sidebar'), 'sidebar collapsed (Expand sidebar)');
            await s.pause(500);
            await s.click(s.button('Expand sidebar'), 'Expand sidebar');
            await s.see(s.button('Collapse sidebar'), 'sidebar open again');
            await s.button('Collapse sidebar').focus();
          } else if (layout === 'drawer') {
            await s.see(s.button('Open menu'), 'the Open menu button');
            await s.click(s.button('Open menu'), 'Open menu (narrow screen)');
            await s.see(s.button('Close menu'), 'navigation drawer open');
            await s.pause(500);
            await s.click(s.button('Close menu'), 'Close menu');
            await s.see(s.button('Open menu'), 'drawer closed');
            await s.click(s.button('Open menu'), 'Open menu again');
            await s.see(s.button('Close menu'), 'drawer open again');
            await s.button('Close menu').focus();
          } else {
            // Tablet width: the navigation is a fixed icon rail with no toggle to exercise.
            await s.see(
              s.page.getByRole('navigation', { name: 'Main' }),
              'the Main navigation (icon rail)',
            );
            s.checks.push(
              'note: no sidebar toggle at this width (icon rail); Tab from the page top',
            );
            await s.page.evaluate(() => document.activeElement?.blur());
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
          // Retry-safe: a memo an earlier attempt saved is not created again; the checks still run.
          // One saved but not yet recorded (the run stopped right after Next) is found in the list
          // by its exact subject and adopted.
          const listed = s.state.memoUrl
            ? []
            : await s.exactLinks(
                await s.loadList(`/memos?q=${encodeURIComponent(subject)}`, {
                  heading: 'Memos',
                  table: 'Memos, newest first',
                  empty: ['No memos match', 'No memos yet'],
                }),
                subject,
              );
          if (listed.length > 1)
            throw new StepFailure(
              `${listed.length} memos carry this run's subject (${listed.join(', ')}); not creating ` +
                'another. Use a new label.',
            );
          if (s.state.memoUrl) {
            s.checks.push('note: the memo was saved by an earlier attempt of this run');
          } else if (listed.length === 1) {
            s.record('memoUrl', listed[0]);
            s.checks.push('note: adopted the memo an earlier attempt of this run saved');
            await openMemo(s);
            const number = /MEMO-[\w/-]*\d{5}/.exec(await s.text())?.[0];
            if (number) s.record('memoNumber', number);
          } else {
            await s.goto('/memos/new', (p) =>
              p.getByRole('combobox', { name: 'Approved by', exact: true }),
            );
            // Controlled inputs: text typed before hydration is wiped. Wait for the page to settle.
            await s.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
            await s.choose('Department', 'Operations');
            // "Leave the date supplied by the form": it should be today in the user's time zone.
            const supplied = await s.page.locator('input[type="date"]').first().inputValue();
            const local = await s.page.evaluate(() => new Date().toLocaleDateString('en-CA'));
            if (supplied !== local)
              s.finding(
                `New memo's supplied date is ${supplied} but today in the browser's time zone is ${local}: ` +
                  'the form defaults to the UTC date (memo-form-model.ts todayIso uses toISOString), so in Nepal ' +
                  'every memo started between 00:00 and 05:45 is dated yesterday.',
                'normal',
              );
            else s.checks.push(`supplied date ${supplied} is today`);
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
            await s.see(s.page.getByRole('heading', { level: 1, name: mine }), 'the saved memo');
            const url = s.page.url().split('?')[0];
            s.record('memoUrl', url.replace(cfg.appUrl, ''));
            const number = /MEMO-[\w/-]*\d{5}/.exec(await s.text())?.[0];
            if (number) s.record('memoNumber', number);
          }
          const memoPath = s.need('memoUrl');

          await s.caption('start-2 — Memos list → open the row');
          await s.goto('/memos', (p) => p.getByRole('heading', { level: 1, name: 'Memos' }));
          const link = s.page.getByRole('link', { name: mine }).first();
          await s.see(link, `Memos row "${subject}"`);
          await s.click(link, 'the memo row');
          await s.page.waitForURL(new RegExp(memoPath.replace(/[/]/g, '\\/')));
          await s.see(s.page.getByRole('heading', { level: 1, name: mine }), 'the memo reopened');
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

          await s.caption('start-3 — Print: only the memo paper goes to the print frame');
          // Headless Chromium shows no print dialog. The app prints from an off-screen iframe
          // (data-memo-print-frame); intercept that frame's print() and read what it would print.
          await s.page.evaluate(() => {
            window.__printed = { calls: 0, text: '' };
            new MutationObserver((records) => {
              for (const r of records)
                for (const n of r.addedNodes)
                  if (n.tagName === 'IFRAME' && n.hasAttribute('data-memo-print-frame')) {
                    n.contentWindow.print = () => {
                      window.__printed.calls++;
                      window.__printed.text = n.contentDocument.body.innerText;
                    };
                  }
            }).observe(document.body, { childList: true });
          });
          await s.click(s.button('Print preview').or(s.button('Print memo')), 'Print');
          await s.page
            .waitForFunction(() => window.__printed.calls > 0, null, { timeout: 30000 })
            .catch(() => {});
          const printed = await s.page.evaluate(() => window.__printed);
          s.expect(
            printed.calls === 1,
            'Print sends one document to the print frame',
            String(printed.calls),
          );
          s.expect(
            printed.text.includes('Please approve delivery'),
            'the print frame holds the memo paper',
          );
          s.expect(
            !/Approval route|Audit timeline|Sign out|Add recommender/.test(printed.text),
            'the print frame holds only the paper (no form, route or app shell)',
            printed.text.slice(0, 200),
          );
          s.checks.push(
            'the browser print dialog itself cannot be shown headless: check it by hand once',
          );

          // Retry-safe: an earlier attempt's submit is not repeated; the frozen-memo checks still run.
          if (s.state.memoRequestId) {
            s.checks.push('note: the memo was submitted by an earlier attempt of this run');
          } else {
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
            // The opener and the confirm are both named "Submit for approval": the opener is looked
            // up in <main> (the dialog is portalled outside it) so it can never match the confirm.
            const submit = s.page
              .getByRole('main')
              .getByRole('button', { name: 'Submit for approval', exact: true });
            await s.see(submit, 'Submit for approval');
            const submitDialog = s.page.getByRole('dialog', { name: 'Submit for approval?' });
            const confirm = submitDialog.getByRole('button', {
              name: 'Submit for approval',
              exact: true,
            });
            // A dev-server reload can close the confirm dialog before its button is clicked (r3f,
            // 20 Nov 2026). Nothing is sent until the confirm, so the dialog is opened again, at
            // most three times, each noted; the confirm itself is clicked once.
            for (let attempt = 1; ; attempt++) {
              // A dialog still open at a retry is cancelled first, so the retry cannot submit.
              if (
                attempt > 1 &&
                (await submitDialog
                  .first()
                  .isVisible()
                  .catch(() => false))
              ) {
                await submitDialog
                  .getByRole('button', { name: 'Cancel', exact: true })
                  .click({ timeout: 5000 })
                  .catch(() => s.page.keyboard.press('Escape'));
                const closed = await submitDialog
                  .waitFor({ state: 'hidden', timeout: 10000 })
                  .then(() => true)
                  .catch(() => false);
                if (!closed)
                  throw new StepFailure(
                    'The Submit for approval? dialog stayed open after Cancel; not retrying, so ' +
                      'the confirm is not clicked by mistake',
                  );
              }
              await s.click(
                submit,
                attempt === 1 ? 'Submit for approval' : 'Submit for approval again',
              );
              const ready = await confirm
                .waitFor({ state: 'visible', timeout: 20000 })
                .then(() => s.pause(400))
                .then(() => confirm.waitFor({ state: 'visible', timeout: 5000 }))
                .then(() => true)
                .catch(() => false);
              if (ready) break;
              if (attempt === 3)
                throw new StepFailure(
                  'The Submit for approval? dialog closed or never opened, three times',
                );
              s.checks.push(
                'note: the Submit for approval? dialog was lost (page reloaded); opening it again',
              );
              await s.page.waitForLoadState('load').catch(() => {});
            }
            await s.click(confirm, 'confirm Submit for approval');
            // Round 3: the page no longer carries `?submitted=pending` or the 'Submitted for approval.'
            // text; the status badge reads Submitted and the route is shown.
            await s.see(
              s.page.getByRole('link', { name: 'View the approval route and history' }),
              'the approval route link',
            );
            await s.see(s.page.getByText('Submitted', { exact: true }).first(), 'status Submitted');
            const href = await s.page
              .getByRole('link', { name: 'View the approval route and history' })
              .getAttribute('href');
            const requestId = /\/inbox\/([0-9a-f-]{36})/.exec(href ?? '')?.[1];
            s.expect(requestId, 'an approval request link', href);
            s.record('memoRequestId', requestId);
          }
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
          // Retry-safe like start-5: an approval an earlier attempt gave is not given again.
          await s.goto(`/inbox/${s.need('memoRequestId')}`, (p) =>
            p.getByRole('list', { name: 'Approval route steps' }),
          );
          const first = await routeSteps(s);
          if (/Approved/i.test(first[0] ?? ''))
            s.checks.push('note: Accountant approved in an earlier attempt of this run');
          else {
            await approveFromInbox(s, 'Demo memo reviewed by Accountant.');
            await s.goto(`/inbox/${s.need('memoRequestId')}`, (p) =>
              p.getByRole('list', { name: 'Approval route steps' }),
            );
          }
          const steps = await routeSteps(s);
          s.expect(steps.length >= 2, 'two route steps', JSON.stringify(steps));
          s.expect(
            /Dev Accountant/.test(steps[0]) && /Approved/i.test(steps[0]),
            'step 1 Dev Accountant is Approved',
            steps[0],
          );
          // A re-run after start-5 finds Finance's approval too: that is a later step's effect.
          if (/Dev Finance/.test(steps[1] ?? '') && /Approved/i.test(steps[1]))
            s.checks.push('note: Finance already approved (start-5 ran in an earlier attempt)');
          else
            s.expect(
              /Dev Finance/.test(steps[1] ?? '') && !/Approved/i.test(steps[1]),
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
          // Retry-safe: an earlier attempt may already have given the final approval.
          await s.goto(`/inbox/${s.need('memoRequestId')}`, (p) =>
            p.getByRole('list', { name: 'Approval route steps' }),
          );
          const done = await routeSteps(s);
          if (done.length >= 2 && /Approved/i.test(done[1]))
            s.checks.push('note: Finance approved in an earlier attempt of this run');
          else await approveFromInbox(s, 'Demo memo approved by Finance.');

          await s.caption(
            'start-5 — Finance opens the approved memo: audit timeline and decisions',
          );
          await openMemo(s);
          await s.see(s.page.getByText('Approved', { exact: true }), 'memo status Approved');
          await s.see(
            s.page.getByRole('heading', { name: 'Audit timeline' }),
            'the audit timeline',
          );
          await s.pause();
          await s.click(
            s.page.getByRole('link', { name: 'View the approval route and history' }),
            'View the approval route and history',
          );
          await s.see(
            s.page.getByText('Demo memo reviewed by Accountant.'),
            "the Accountant's decision comment",
          );
          await s.see(
            s.page.getByText('Demo memo approved by Finance.'),
            "Finance's decision comment",
          );
          await s.pause();

          await asPersona(s, 'Dev Sales');
          await s.caption('start-5 — Sales: Memos → the approved memo');
          await s.goto('/memos', (p) => p.getByRole('heading', { level: 1, name: 'Memos' }));
          await s.click(s.page.getByRole('link', { name: mine }).first(), 'the memo row');
          await s.see(s.page.getByRole('heading', { level: 1, name: mine }), 'the memo');
          await s.see(s.page.getByText('Approved', { exact: true }), 'status Approved for Sales');

          // Leave the memo first, so landing on it can only come from the notification click.
          await s.goto('/', (p) => p.getByRole('button', { name: 'Dev menu' }));
          await s.caption('start-5 — notification bell: opening the panel must not mark all read');
          const bell = s.page.getByRole('button', { name: /^Notifications/ });
          const before = await bell.first().getAttribute('aria-label');
          const panel = s.page.getByRole('region', { name: 'Notifications panel' });
          const item = panel
            .getByRole('listitem')
            .filter({ hasText: runMatch(s.state.memoNumber ?? subject) });
          const link = item.first().getByRole('link').first();
          // A dev-server rebuild can reload the page under the open panel (r2d before the click,
          // r3c before the item showed), which closes it. The panel is reopened, at most three
          // openings in all, each noted; a panel that stays open without the item still fails.
          let openings = 0;
          const openPanel = async () => {
            for (;;) {
              // Idempotent: the bell toggles the panel, so it is clicked only while the panel is closed.
              if (
                !(await panel
                  .first()
                  .isVisible()
                  .catch(() => false))
              ) {
                openings++;
                await s.click(bell, openings === 1 ? 'the notification bell' : 'the bell again');
              }
              await s.see(panel, 'the notifications panel');
              const found = await Promise.race([
                link
                  .waitFor({ state: 'visible', timeout: 60000 })
                  .then(() => 'item')
                  .catch(() => 'none'),
                panel
                  .waitFor({ state: 'hidden', timeout: 60000 })
                  .then(() => 'closed')
                  .catch(() => 'none'),
              ]);
              if (found === 'item') return;
              if (found !== 'closed' || openings >= 3)
                throw new StepFailure(
                  found === 'closed'
                    ? 'The notifications panel closed itself three times'
                    : `Expected to see: a notification for ${s.state.memoNumber ?? subject} in the open panel`,
                );
              s.checks.push('note: the notifications panel closed (page reloaded); reopening it');
            }
          };
          await openPanel();
          s.checks.push('saw: a notification for this memo');
          await s.page.waitForTimeout(1500);
          const after = await bell.first().getAttribute('aria-label');
          const unread = (t) => Number(/(\d+) unread/.exec(t ?? '')?.[1] ?? 0);
          s.expect(
            unread(after) >= unread(before),
            'opening the panel alone did not mark anything read',
            `${before} → ${after}`,
          );
          await s.pause(400);
          if (!(await link.isVisible().catch(() => false))) {
            s.checks.push('note: the notification was not visible before the click; looking again');
            await openPanel();
          }
          await s.click(link, 'the matching notification');
          const memo = new URL(s.need('memoUrl'), cfg.appUrl);
          const reached = await s.page
            .waitForURL((u) => u.origin === memo.origin && u.pathname === memo.pathname, {
              timeout: cfg.navTimeout,
            })
            .then(() => true)
            .catch(() => false);
          s.expect(reached, `the notification opened this memo (${memo.pathname})`, s.page.url());
          await s.see(s.page.getByRole('heading', { level: 1, name: mine }), 'the memo heading');

          await s.caption('start-5 — Test mail: the message for this memo');
          const mail = await findMail(cfg, `subject:"${s.state.memoNumber ?? subject}"`, 90000, {
            signal: s.signal,
          });
          s.expect(mail, `a Mailpit message about ${s.state.memoNumber ?? subject}`);
          s.record('memoMailSubject', mail.Subject);
          if (/(^|\s)[a-z]+_[a-z_]+\s/.test(mail.Subject))
            s.checks.push(`observation: the e-mail subject uses the type key ("${mail.Subject}")`);
          await s.goto(`${cfg.mailUrl}/view/${mail.ID}`, (p) =>
            p.getByText(mail.Subject).filter({ visible: true }).first(),
          );
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
          const { context: priv, page } = await s.openWindow('private-window');
          await realLogin(s, page, 'sales', `${cfg.appUrl}/`);
          const who = await s.whoami(page);
          s.expect(
            who && who.roles.includes('sales'),
            'real sign-in reached the workspace as Sales',
            JSON.stringify(who),
          );
          await page.waitForTimeout(cfg.pace);
          // Evidence for the outcome: the hops after Sign out, as host + path + status only (the
          // callback's query carries a code, so no query is kept).
          const hops = [];
          const onResponse = (r) => {
            const u = new URL(r.url());
            if (/^\/(_next|telemetry|__nextjs)/.test(u.pathname)) return;
            hops.push(`${r.request().method()} ${u.host}${u.pathname} ${r.status()}`);
          };
          page.on('response', onResponse);
          const signOut = page.getByRole('button', { name: 'Sign out', exact: true });
          const waitLeftApp = () =>
            page
              .waitForURL(
                (u) =>
                  !u.href.startsWith(`${cfg.appUrl}/`) ||
                  /\/auth\//.test(u.pathname) ||
                  /signed-?out/i.test(u.href),
                { timeout: 45000 },
              )
              .then(() => true)
              .catch(() => false);
          // A logout hop proves the click reached the app; without one a dev-server reload may have
          // swallowed the click, which is a driver retry, not a product finding.
          const sawLogout = () => hops.some((h) => /logout|end_session/i.test(h));
          await s.hydrated(signOut);
          await signOut.first().click();
          let leftApp = await waitLeftApp();
          if (!leftApp && !sawLogout()) {
            s.checks.push(
              'note: Sign out sent no logout request (page reloaded?); clicking it again',
            );
            await page.waitForLoadState('load').catch(() => {});
            await s.hydrated(signOut);
            await signOut.first().click();
            leftApp = await waitLeftApp();
          }
          page.off('response', onResponse);
          s.checks.push(
            `after Sign out: ${new URL(page.url()).host}${new URL(page.url()).pathname}`,
          );
          if (!leftApp) {
            // Still on the workspace: either a signed-out page there, or signed straight back in.
            const again = await s.whoami(page);
            s.checks.push(`hops after Sign out: ${hops.join(' → ') || '(none)'}`);
            if (again?.roles?.length && !sawLogout())
              throw new StepFailure(
                'The Sign out click had no effect, twice (page reloaded?); no logout request was sent',
              );
            if (again?.roles?.length) {
              s.finding(
                'Sign out did not sign out: after a real password + one-time-code sign-in, Sign out ' +
                  'returned to the workspace still signed in as Sales. Hops: ' +
                  hops.join(' → '),
                'high',
              );
              throw new StepFailure(
                'Sign out left the private window signed in (see the finding and the hops)',
              );
            }
          }
          // Logout is proven only by the app's own logout POST answering without an error.
          const appHost = new URL(cfg.appUrl).host;
          const logoutPosted = hops.some((h) => {
            const [method, hostPath, status] = h.split(' ');
            return (
              method === 'POST' && hostPath === `${appHost}/auth/logout` && Number(status) < 400
            );
          });
          s.expect(
            logoutPosted,
            `the Sign out click sent POST ${appHost}/auth/logout and it succeeded`,
            hops.join(' → ') || '(no hops)',
          );
          // A dev-server restart can answer one hop with 5xx; retry the plain GET, never the sign-out.
          let probed = false;
          for (let i = 0; i < 4 && !probed; i++) {
            const res = await page
              .goto(`${cfg.appUrl}/inbox`, { waitUntil: 'domcontentloaded' })
              .catch(() => null);
            await page.waitForLoadState('load').catch(() => {});
            probed = Boolean(
              res && res.status() < 500 && !page.url().startsWith('chrome-error://'),
            );
            if (probed) break;
            s.checks.push(`note: /inbox answered ${res?.status() ?? 'a network error'}; retrying`);
            await page.waitForTimeout(10000);
          }
          if (!probed)
            throw new StepFailure(
              'Could not load /inbox after Sign out (four tries); signed-out state not proven',
            );
          const signInVisible = await page
            .locator('input[name=loginName]')
            .waitFor({ state: 'visible', timeout: cfg.navTimeout })
            .then(() => true)
            .catch(() => false);
          s.expect(
            new URL(page.url()).origin === new URL(cfg.authUrl).origin && signInVisible,
            'signed out: /inbox sends you to the sign-in page with its login form',
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
