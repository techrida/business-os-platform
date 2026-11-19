# Manual-run driver

This driver performs the Business OS manual test guide through the real UI and records one video
per workflow per viewport. It is development and test tooling only. It is listed in `.dockerignore`
and lives outside `apps/*`, so no production image or route manifest includes it.

| Workflow      | Guide steps                                                                       | Status                                |
| ------------- | --------------------------------------------------------------------------------- | ------------------------------------- |
| `start`       | start-1 … start-6 (memo, approvals, notification, mail, private window)           | implemented                           |
| `sales`       | sales-1 … sales-15 (lead → verification → quotation → order → invoice → payments) | implemented                           |
| `procurement` | procurement-1 … 15                                                                | Phase B (reported as NOT-IMPLEMENTED) |
| `branches`    | branches-1 … 12                                                                   | Phase B (reported as NOT-IMPLEMENTED) |

## Setup

```sh
export PATH=/home/crestia/.local/share/mise/installs/node/24.22.2/bin:$PATH   # Node 24
pnpm install --frozen-lockfile --prefer-offline   # Playwright comes from apps/workspace
export PERSONAS_FILE=<stack>/.dev/personas.json   # read-only; never printed or copied
```

Playwright is loaded from `apps/workspace`'s `@playwright/test` dependency. Set `PLAYWRIGHT_FROM`
to another `package.json` to use a different copy. The driver uses Playwright's own Chromium, or
`CHROMIUM_PATH` if set. `pdftotext` (poppler) is optional; without it the PDF text checks are skipped
and a note is written.

## Run

```sh
node tools/manual-run/run.mjs --workflow start,sales --viewport 1440x900 --label SCR1
node tools/manual-run/run.mjs --workflow all --viewport all --label SCR2   # three viewports, one after another
node tools/manual-run/run.mjs --workflow sales --label SCR1 --from sales-7  # resume (see limits)
node tools/manual-run/run.mjs --workflow sales --label SCR1 --only sales-3,sales-4
```

Flags: `--workflow start|sales|procurement|branches|all` (comma list allowed), `--viewport 1440x900|820x1180|390x844|all`, `--label`, `--from <step>`, `--only <step,step>`, `--headed`, `--no-captions`.

The exit code is 0 only when every workflow is PASS (or NOT-IMPLEMENTED).

Output goes to `$VIDEO_DIR/<label>/<viewport>/`:

- `<workflow>.webm`: the main recorded window. `<workflow>-pageN.webm` holds extra tabs, and `<workflow>-<window>.webm` holds a second window, such as start-6's private window. A `--from <step>` run records its own segment, `<workflow>-from-<step>.webm`, and keeps the earlier segment.
- `results.json` and `results.md` record, per step: the status (PASS, FAIL, BLOCKED or SKIPPED), duration, every assertion, the record numbers created, findings, console and network errors, and the video paths.
- `shots/<step>-FAIL.png`: a full-page screenshot taken when a step fails.
- `state.json`: the records passed between steps (URLs, numbers).
- `downloads/` and `demo-files/`.

`$VIDEO_DIR/<label>/summary.md` and `summary.json` hold the totals for one invocation.

When a step fails, the rest of that workflow is BLOCKED and the run moves on to the next workflow. `results.json` is saved before every step. A run that is killed therefore keeps the steps it finished, with workflow status `RUNNING`. Its video stays unnamed in `.video-tmp/` and has no duration header; `ffmpeg -i <file> -c copy <out>.webm` makes it playable.

Step authoring helper (records nothing):

```sh
node tools/manual-run/probe.mjs --persona "Dev Sales" --url /leads/new --text --shot /tmp/x.png
```

It lists every visible control with the role and accessible name that `getByRole` and `getByLabel` will match.

## Environment

| Variable                                                 | Default                                  | Meaning                                                                           |
| -------------------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| `APP_URL`                                                | `https://app.testrun.localhost:58343`    | staff workspace                                                                   |
| `PORTAL_URL`                                             | `https://portal.testrun.localhost:58343` | customer portal (not used in Phase A)                                             |
| `MAIL_URL`                                               | `https://mail.testrun.localhost:58343`   | Mailpit UI and API                                                                |
| `AUTH_URL`                                               | `APP_URL` with `app.` → `auth.`          | ZITADEL login origin (real sign-in, start-6)                                      |
| `PERSONAS_FILE`                                          | required                                 | the stack's `.dev/personas.json`; only read in memory                             |
| `CA_FILE`                                                | `<personas dir>/caddy-root.crt`          | the stack's local CA; TLS is always verified. `NODE_EXTRA_CA_CERTS` is never used |
| `RUN_LABEL` / `--label`                                  | required                                 | makes every name, PAN, email and bank reference unique                            |
| `VIEWPORT` / `--viewport`                                | `1440x900`                               | page size and video size                                                          |
| `VIDEO_DIR`                                              | `/home/crestia/bos-runtimes/manual-run`  | output root, outside git                                                          |
| `PACE`                                                   | `600`                                    | ms pause after each action so viewers can follow                                  |
| `SLOWMO`                                                 | `0`                                      | Playwright slowMo                                                                 |
| `HEADLESS` / `--headed`                                  | headless                                 |                                                                                   |
| `CAPTIONS` / `--no-captions`                             | on                                       | caption banner overlay                                                            |
| `DEMO_FILES`                                             | generated tiny PDFs                      | demo kit folder (customer-pan.pdf, payment-proof.pdf, …)                          |
| `NETNS`                                                  | `auto`                                   | `0` turns off network isolation; `auto` and `1` refuse a non-loopback origin      |
| `ALLOW_NON_LOCAL_TARGET`                                 | unset                                    | `1` allows origins outside the local hosts listed below                           |
| `BROWSER_TZ`                                             | host zone                                | browser time zone                                                                 |
| `STEP_TIMEOUT_MS`, `ACTION_TIMEOUT_MS`, `NAV_TIMEOUT_MS` | 360000 / 45000 / 120000                  | per-step limits; long steps set their own                                         |

### Another stack or machine

Point `APP_URL`, `MAIL_URL`, `PERSONAS_FILE` and `CA_FILE` at that stack and pick a fresh label. The Dev switcher must be enabled, which means a development build with seeded Dev accounts.

Target guard: every origin (`APP_URL`, `PORTAL_URL`, `MAIL_URL`, `AUTH_URL`) must be `https://` with no path, and its host must be `localhost`, `*.localhost`, `127.0.0.1` or `*.bos.test`. Anything else stops the run before a browser starts, unless `ALLOW_NON_LOCAL_TARGET=1` is set. `http://` origins are always refused.

Network isolation needs every origin on loopback (`localhost`, `*.localhost`, `127.0.0.1`). A `*.bos.test` or other non-loopback origin stops the run unless `NETNS=0` is set; isolation is never turned off silently. With `NETNS=auto` and `unshare`, `socat` or `ip` missing, the run prints a note and uses the normal network.

## How it works

- **One recorded context per workflow per viewport.** Personas switch inside that context through the real `/dev/personas` page, one click each. The step then confirms the role through `/dev/api/whoami`. Authentication is never bypassed. start-6 signs in for real in a second recorded window, with password plus a TOTP code computed from the personas file.
- **TLS.** Node checks each origin's certificate chain against the stack CA. Chromium is then told to trust only those certificate keys (`--ignore-certificate-errors-spki-list`). `ignoreHTTPSErrors` stays false.
- **Network isolation (`lib/netns.mjs`).** Chromium runs in its own user and network namespace (`unshare -Urn`), and socat forwards the loopback ports. Without this, host network changes (VPN, Wi-Fi, Docker bridges) aborted page loads with `ERR_NETWORK_CHANGED`.
- **Hydration wait.** Next.js pages render before React attaches handlers, and a click in that window does nothing. Before each click, `Session.click` waits up to 30 s for React to hydrate the element (the `__reactProps$` key). It reloads up to four times, and only under the conditions listed below.
- **Dev-server hiccups.** `next dev` restarts itself when it nears its memory limit ("Server is approaching the used memory threshold, restarting…"). For up to a minute after that, pages, script chunks and stylesheets answer 502. The driver recovers without hiding real failures:
  - `goto` and `see` reload a Chrome error page or the app's "This … did not open" panel (a plain GET, at most three times) and write a `note:` line in the step's checks.
  - Before each click or fill, a page that never hydrated, or whose Next stylesheet failed while no field holds typed input, is reloaded. Before that reload it waits (up to 3 min) until the page's own `/_next/` scripts and stylesheets answer 200 again. Right after a restart they keep failing for minutes, and an early reload just fails the same way.
  - A page that may hold input, or may be mid-submit, is never reloaded. A reload there once threw away a filled payment form, and a second click could have recorded the payment twice.
  - An error that remains after the reloads fails the step.
- **Captions.** The caption banner is a fixed shadow-DOM overlay with `pointer-events:none`. It is inserted only after hydration, because inserting it earlier broke hydration. Turn it off with `--no-captions`.
- **Unique data.** All unique values come from `runKey = <label>-<viewport width>`, so the three viewport runs of one label never collide. A run only opens and changes records it created; existing manual-run records are never touched.

## Adding steps or a workflow (Phase B)

A workflow module exports `workflow(cfg)`, which returns `{ name, title, steps: [{ id, title, timeoutMs?, run(s) }] }`. See `workflows/start.mjs`.

Inside `run(s)`, use the `Session` API from `lib/session.mjs`. Never call `page.click` directly:

- `s.switchTo('Dev Procurement')`, `s.goto(path, readyLocatorFn)`
- `s.click(locator, what)`, `s.fill(label, value)`
- `s.choose(labelOrTrigger, optionTextOrRegExp)` for custom selects, `s.typeahead(box, name)`
- `s.chooseFile(button, file)`, `s.download(locator)`
- `s.see(locator, message)` for each "You should see", `s.expect(cond, message)`, `s.notVisible`
- `s.record('poNumber', 'PO-…')` to keep a value for later steps, `s.need('poNumber')` to read one
- `s.finding(text, severity)` for a real product bug. Do not work around a product bug; assert only the behaviour that works.
- `s.caption(text)`, `s.pause(ms)`

Make every step retry-safe. If `s.state` already holds the record the step creates, open that record instead of creating it again (sales-2, sales-8, sales-10, sales-11, start-5). A record found by this run's unique name works too (`adoptPayment` in sales-12 and sales-15). Submit once, then wait for the result or a stated refusal. Never click Submit again on a timeout.

Assert on something the action changes. For example, count the rows that carry a `Deallocate` action before and after allocating. An old row with the same text would make a plain "row is visible" check pass even when the action was refused.

### Selector gotchas found in Phase A

- Custom selects are `button[aria-haspopup="listbox"]` with a label. Their options are `role=option`, in the listbox named by `aria-controls`. `s.choose` handles that case, a native `<select>`, and a hidden input with the field's name.
- Typeahead options include a second line. Match the name line exactly: `^Name( \(.+\))?$`.
- Uploads: a native file chooser opens, then a preview dialog named after the file, and its **Save** stores the file. Wait for the virus scan ("Virus free") before submitting.
- Approvals: go to Inbox, open the matching row in the table "Waiting approvals" (match it by the record number or this run's unique name), click Approve, then fill "Approve request" → "Comment (optional)" → Approve. The URL then becomes `/inbox?decided=approve`.
- Money is shown with Nepali grouping (`1,35,600.00`). Compare amounts with the commas removed (`hasAmount` in `workflows/sales.mjs`).
- Confirmation dialogs repeat the action's name, so scope the button lookup to the dialog.
- Some status text appears both in the page and in toasts. Use `exact: true` with `.first()`.
- Invoice actions (Submit, Issue): confirm in the dialog, which then shows **Done**. Clicking Done reloads the page to the new status; until then the page behind it still shows the old status.
- The guide says "Download PDF", but the issued invoice has **View PDF**, which opens a preview dialog named `<INV number with / as ->.pdf` with a Download link inside. The PDF is rendered and scanned in the background, and the document route answers 404 until then (sales-11 waits for it).
- The sales order links to its quotation through a **View quotation** link, not by showing the QT number.
- Payments list rows carry no bank reference. Match a row by this run's unique customer name.
- Navigation by width: 1440 has Collapse/Expand sidebar, 820 has a fixed icon rail with no toggle, and 390 has Open menu/Close menu.
- Mailpit's message view also has hidden copies of the subject at narrow widths. Match it with `.filter({ visible: true })`.

## Known limits

- One uninterrupted `--workflow all --viewport 1440x900` run (start + sales) took 22 min on the shared omarchy machine (label SCR2, 20 Nov 2026). Most of that is waiting for the dev server to compile routes and render PDFs, not the driver.

- `--from` reloads `state.json` and skips the earlier steps; their results are kept from the earlier run. Retry-safe after a partial run: start-5, sales-2, sales-8 and sales-10 to sales-15. Any other step that already changed data (a created lead, a submitted memo or a built quotation, say) cannot be re-run on the same label. Resume from the step after it, or start a new label.
- The workspace dev server restarts itself under memory pressure, so a run on a loaded machine may need one or two `--from` resumes. The segments together form the run's video.
- The browser print dialog cannot be shown headless. start-3 checks the print frame's content instead of a printed page.
- The TOTP code appears briefly in the private-window video of start-6. It expires within 30 s, but treat that video as internal.
- Portal steps (customer side) are not driven in Phase A.
- No database checks are used. Every assertion goes through the UI, Mailpit or downloaded files.
- The video is the browser viewport only. Native file-chooser windows and downloads are not visible in it.
