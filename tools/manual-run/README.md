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
node tools/manual-run/run.mjs --workflow start,sales --viewport 1440x900 --label run1
node tools/manual-run/run.mjs --workflow all --viewport all --label run2   # three viewports, one after another
node tools/manual-run/run.mjs --workflow sales --label run1 --from sales-7  # resume (see limits)
node tools/manual-run/run.mjs --workflow sales --label run1 --only sales-3,sales-4
```

Flags: `--workflow start|sales|procurement|branches|all` (comma list allowed), `--viewport 1440x900|820x1180|390x844|all`, `--label`, `--from <step>`, `--only <step,step>`, `--fresh`, `--headed`, `--no-captions`.

- `--from <step>` resumes one workflow at that step with the records of the earlier run. With several workflows, the ones listed before the owner of that step are not run (`NOT-RUN`; their results stay as they are), and the ones after it run in full. `--workflow all --from sales-7` therefore leaves `start` alone, resumes `sales` and runs the rest.
- `--only <step,step>` runs just those steps with the earlier run's records; a workflow with none of them is not run.
- An empty `--from` or `--only` (`--from=`, `--only "$UNSET"`) stops the run with exit code 2; it never turns into a full run. A workflow or viewport named twice in one command is refused too.
- One run per output folder at a time: the run takes `<label>/<viewport>/.lock` (created exclusively, holding its pid) before it looks at earlier runs and keeps it until it exits. A second invocation on the same folder stops with exit code 2; a lock whose process is gone is taken over.
- A folder belongs to one stack: `state.json` stores the `appUrl` (and run key) it was created with, and a run against another `APP_URL` is refused. Folders from before 20 Nov 2026 are checked against the `appUrl` in their `results.json`.
- A full run of a workflow that already ran under this label and viewport stops before launch. Use a new label, resume with `--from`, or pass `--fresh` to start that workflow over: its records are cleared (a copy is kept as `state-before-fresh.json`), its earlier result moves to `history` in `results.json`, and the earlier run's records still carry the same unique names, so a new label is safer.
- An unknown workflow, step or label, a bad origin, a viewport with leading zeros (`0390x844`), a missing CA file and `NODE_TLS_REJECT_UNAUTHORIZED=0` stop the run with exit code 2 before any browser starts.

The exit code is 0 only when every workflow is PASS, NOT-IMPLEMENTED or NOT-RUN.

Output goes to `$VIDEO_DIR/<label>/<viewport>/`:

- `<workflow>.webm`: the main recorded window. `<workflow>-pageN.webm` holds extra tabs, and `<workflow>-<window>.webm` holds a second window, such as start-6's private window. A `--from <step>` run records its own segment, `<workflow>-from-<step>.webm`, and an `--only` run `<workflow>-only-<step>_<step>.webm`. No file is ever replaced: a name that exists gets `-2`, `-3` … (`sales-2.webm`, `sales-from-sales-7-2.webm`). Names (videos, screenshots, `state-before-fresh.json`) are claimed by creating the file exclusively before it is written, so two writers never get the same one.
- `results.json` and `results.md` record, per step: the status (PASS, FAIL, BLOCKED or SKIPPED), duration, every assertion, the record numbers created, findings, console and network errors, and the video paths. A run that could not start (TLS check, browser launch) is a FAIL with its reason. `--from` and `--only` runs merge with the earlier result; every replaced result is kept under `history.<workflow>` in `results.json`.
- `shots/<step>-FAIL.png` (then `-FAIL-2.png` …): a full-page screenshot taken when a step fails.
- `state.json`: the records passed between steps (URLs, numbers), per workflow, plus the folder's `appUrl` and run key. It is written (atomically, through a temporary file of its own) every time a step records a value, so a record survives a stop right after the change it describes. Only `--from` and `--only` read the records.
- `downloads/` and `demo-files/`.

`$VIDEO_DIR/<label>/summary.md` and `summary.json` hold the totals for one invocation.

When a step fails, the rest of that workflow is BLOCKED and the run moves on to the next workflow. A workflow that cannot start, or a driver error, is saved as FAIL and the next workflow still runs; a driver error keeps the steps already saved. The browser and network forwarders are closed in every case. `results.json` is saved before and after every step, and the final result (all steps) is saved before the browser closes and the videos are named; a video that cannot be moved out of `.video-tmp/` is reported as `videoError` without touching the steps. A run that is stopped (Ctrl-C, `kill`) saves its results and records before it exits: the steps it finished, the step it was in as `INTERRUPTED`, workflow status `RUNNING` and `interrupted: true`. Its video stays unnamed in `.video-tmp/` and has no duration header (also after Ctrl-C or SIGTERM, checked on 20 Nov 2026); `ffmpeg -i <file> -c copy <out>.webm` makes it playable.

Step authoring helper (records nothing):

```sh
node tools/manual-run/probe.mjs --persona "Dev Sales" --url /leads/new --text --shot /tmp/x.png
```

It lists every visible control with the role and accessible name that `getByRole` and `getByLabel` will match. Its output is redacted like the runner's: URLs and links lose their query and fragment, and password, one-time-code and hidden inputs print `[hidden]` instead of their value. `--origins` lists the origins the page requested; a request outside the configured origins is blocked and printed as `BLOCKED <url>`.

## Self-tests

```sh
node --test 'tools/manual-run/selftest/*.selftest.mjs'   # no browser, no stack
```

They cover label normalisation and anchored matching, viewport spelling and run keys, the origin guard (configuration and run time), URL and secret redaction (a fake Playwright error carrying the password and codes), the sign-in's generic errors and its refusal to type outside `AUTH_URL`, `--from`/`--only` planning (also empty values), no-overwrite naming, claimed names, temporary files and the folder lock, results history and redacted results, per-workflow state and the folder's stack and run key, shell-safe launcher paths, the step time limit (also a body that resolves just after it) and the payment decision (failed lookup, two matches, exact versus contained reference). Quote the glob: Node expands it itself, and `node --test <folder>` does not work on Node 24. The `.selftest.mjs` suffix keeps them out of every vitest `include` glob.

## Environment

| Variable                                                 | Default                                  | Meaning                                                                                                                            |
| -------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`                                                | `https://app.testrun.localhost:58343`    | staff workspace                                                                                                                    |
| `PORTAL_URL`                                             | `https://portal.testrun.localhost:58343` | customer portal (not used in Phase A)                                                                                              |
| `MAIL_URL`                                               | `https://mail.testrun.localhost:58343`   | Mailpit UI and API                                                                                                                 |
| `AUTH_URL`                                               | `APP_URL` with `app.` → `auth.`          | ZITADEL login origin (real sign-in, start-6)                                                                                       |
| `PERSONAS_FILE`                                          | required                                 | the stack's `.dev/personas.json`; only read in memory                                                                              |
| `CA_FILE`                                                | `<personas dir>/caddy-root.crt`          | the stack's local CA; TLS is always verified. `NODE_EXTRA_CA_CERTS` is never used, and `NODE_TLS_REJECT_UNAUTHORIZED=0` is refused |
| `RUN_LABEL` / `--label`                                  | required                                 | letters and digits only, lower-cased (`SCR1` is `scr1`); makes every name, PAN, email and bank reference unique                    |
| `VIEWPORT` / `--viewport`                                | `1440x900`                               | page size and video size; written without leading zeros                                                                            |
| `VIDEO_DIR`                                              | `/home/crestia/bos-runtimes/manual-run`  | output root, outside git                                                                                                           |
| `PACE`                                                   | `600`                                    | ms pause after each action so viewers can follow                                                                                   |
| `SLOWMO`                                                 | `0`                                      | Playwright slowMo                                                                                                                  |
| `HEADLESS` / `--headed`                                  | headless                                 |                                                                                                                                    |
| `CAPTIONS` / `--no-captions`                             | on                                       | caption banner overlay                                                                                                             |
| `DEMO_FILES`                                             | generated tiny PDFs                      | demo kit folder (customer-pan.pdf, payment-proof.pdf, …)                                                                           |
| `NETNS`                                                  | `auto`                                   | `0` turns off network isolation (needs `ALLOW_NO_NETNS=1`); `auto` and `1` refuse a non-loopback origin                            |
| `ALLOW_NO_NETNS`                                         | unset                                    | `1` accepts a run without network isolation (`NETNS=0`, or `auto` without `unshare`/`socat`/`ip`)                                  |
| `ALLOW_NON_LOCAL_TARGET`                                 | unset                                    | `1` allows origins outside the local hosts listed below                                                                            |
| `BROWSER_TZ`                                             | host zone                                | browser time zone                                                                                                                  |
| `STEP_TIMEOUT_MS`, `ACTION_TIMEOUT_MS`, `NAV_TIMEOUT_MS` | 360000 / 45000 / 120000                  | per-step limits; long steps set their own                                                                                          |

### Another stack or machine

Point `APP_URL`, `MAIL_URL`, `PERSONAS_FILE` and `CA_FILE` at that stack and pick a fresh label. The Dev switcher must be enabled, which means a development build with seeded Dev accounts.

Target guard: every origin (`APP_URL`, `PORTAL_URL`, `MAIL_URL`, `AUTH_URL`) must be `https://` with no path, and its host must be `localhost`, `*.localhost`, `127.0.0.1` or `*.bos.test`. Anything else stops the run before a browser starts, unless `ALLOW_NON_LOCAL_TARGET=1` is set. `http://` origins are always refused.

Run-time origin checks (also with `NETNS=0`): the browser context aborts every request and WebSocket to an origin other than `APP_URL`, `PORTAL_URL`, `MAIL_URL` and `AUTH_URL` (`data:`, `blob:` and `about:` stay allowed) and records the URL, without its query, as a finding of the step. Service workers are blocked in every context, because their fetches bypass that guard. `Session.goto` refuses an absolute URL on any other origin, and the real sign-in types the login name, the password and the one-time code only while the page is on `AUTH_URL`'s origin exactly. Routing every request through the driver turns off Chromium's HTTP cache for the run.

The request guard sees only the first request of a redirect chain: Chromium follows a `3xx` to another origin without asking it again. The driver detects such a hop (a redirected request to another origin, or a main-frame navigation of any window or popup that lands elsewhere, also during a raw `waitForURL`): the step is aborted at once (no further typing or clicking), the page goes to `about:blank`, and a high finding names the URL without its query. Chrome's own error page (`chrome-error://`, a dev-server 502) is not treated as another site. Detection is after the fact: the redirected request has already been sent.

**What actually prevents egress is the network namespace** (`NETNS`, the default on Linux): inside it only the forwarded loopback ports exist, so a redirect to any other host cannot connect. Network isolation needs every origin on loopback (`localhost`, `*.localhost`, `127.0.0.1`). A `*.bos.test` or other non-loopback origin stops the run unless `NETNS=0` is set. Running without isolation (`NETNS=0`, or `NETNS=auto` with `unshare`, `socat` or `ip` missing) also needs `ALLOW_NO_NETNS=1` (or `ALLOW_NON_LOCAL_TARGET=1`), stops with exit code 2 before any browser starts otherwise, and prints a prominent warning that a redirect to an unconfigured origin can then only be detected, not prevented.

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
- **Step time limits.** When a step runs past its limit it has failed at that moment, even if its body finishes a moment later. It is cancelled: every `Session` helper refuses to act from then on (`s.record` included, so it cannot change the run's records), Node-side waits (`s.pause`, Mailpit polling through `s.signal`) end, and the session's windows abort all network requests, so nothing the step still does (a raw dialog click included) reaches the server. The step is saved as FAIL with the time-limit message, and its screenshot and caption follow.
- **Stopping early.** Ctrl-C (SIGINT) or `kill` (SIGTERM) first saves `results.json` and `state.json` (see above), then closes the browser and the network forwarders, releases the folder lock and exits with 130 or 143.
- **Secrets.** Every persona password and TOTP secret in `PERSONAS_FILE` is registered with a redactor when the file is read, and each one-time code when it is computed. Everything the driver writes (console lines, captions, `results.json`, `results.md`, summaries, probe output) passes through it, so a value Playwright quotes in a failed `fill` is written as `[redacted]`; one-time codes are matched for the current window and two on either side. The real sign-in never passes Playwright's error or call log on: it fails with the stage it was in (for example "type the password").
- **Captions.** The caption banner is a fixed shadow-DOM overlay with `pointer-events:none`. It is inserted only after hydration, because inserting it earlier broke hydration. Turn it off with `--no-captions`.
- **Unique data.** All unique values come from `runKey = <label>-<width>x<height>`, each as four digits (`scr1-1440x0900`, `scr1-0390x0844`), so viewport runs of one label never collide, also two with the same width. Labels are lower-cased and hold no dash, so `SCR1` and `scr1` are the same label, and with fixed-width sizes one run key can never be the start of another. An output folder keeps the run key it was created with (stored in `state.json`); a folder from before 20 Nov 2026 keeps its width-only key (`scr1-1440`), so resuming it still finds its records. Rows, links and headings are therefore found by this run's name as literal, case-sensitive text (`runMatch` in `lib/config.mjs`), which also works where a table row runs the next cell straight on after the name. A run only opens and changes records it created; existing manual-run records are never touched. Output folders from before 20 Nov 2026 with upper-case labels (`SCR1`, `SCR2`, `SCR3`) cannot be resumed under the lower-cased label. Do not reuse those labels either: the app may compare customer names without case, so pick a label not used before. The customer's e-mail is `anu.mr-<run key>@bos-demo.example.com` (`anu.scr-` before 20 Nov 2026). sales-2 records the address it used, and a resumed folder from before that change uses the old form, so sales-8 still finds its quote mail.

## Adding steps or a workflow (Phase B)

A workflow module exports `workflow(cfg)`, which returns `{ name, title, origins?, steps: [{ id, title, timeoutMs?, run(s) }] }`. `origins` lists the origins whose certificates are checked before launch (`app`, `portal`, `mail`, `auth`; all four when omitted), so a stack whose portal is down can still run a staff-only workflow. See `workflows/start.mjs`.

Inside `run(s)`, use the `Session` API from `lib/session.mjs`. Never call `page.click` directly:

- `s.switchTo('Dev Procurement')`, `s.goto(path, readyLocatorFn)`
- `s.click(locator, what)`, `s.fill(label, value)`
- `s.choose(labelOrTrigger, optionTextOrRegExp)` for custom selects, `s.typeahead(box, name)`
- `s.chooseFile(button, file)`, `s.download(locator)`
- `s.see(locator, message)` for each "You should see", `s.expect(cond, message)`, `s.notVisible`
- `s.record('poNumber', 'PO-…')` to keep a value for later steps, `s.need('poNumber')` to read one
- `s.finding(text, severity)` for a real product bug. Do not work around a product bug; assert only the behaviour that works.
- `s.caption(text)`, `s.pause(ms)`

Make every step retry-safe: before each action that changes data, check whether its effect is already there and skip that action if so. Use `s.state` (the record an earlier attempt saved, as in sales-2 and sales-10), the page (a status such as `Accepted`, a missing button, a reversal row, as in sales-9 and sales-14), or a record found by this run's unique value with an exact match (`s.loadList` + `s.exactLinks` in start-2 and sales-1; `findOrRecordPayment` in sales-12 and sales-15). A lookup must prove the list loaded (its table or its empty state, and no "did not load" alert) before "not found" may lead to a create; two matches fail the step. Where neither can tell, fail closed with a message naming the step to resume from (sales-1, sales-3, sales-6). `s.record` a value right after the change it describes: it writes `state.json` at once. Submit once, then wait for the result or a stated refusal. Never click Submit again on a timeout.

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
- Payments list rows carry no bank reference. Match rows by this run's unique customer name in the Customer cell (`/payments?q=<name>` filters the list), then read **Bank reference** (`dt` → `dd`) on each payment's own page and compare it exactly. A failed list load shows the `Payments` heading with the alert "The payments did not load".
- Navigation by width: 1440 has Collapse/Expand sidebar, 820 has a fixed icon rail with no toggle, and 390 has Open menu/Close menu.
- Mailpit's message view also has hidden copies of the subject at narrow widths. Match it with `.filter({ visible: true })`.

## Known limits

- One uninterrupted `--workflow all --viewport 1440x900` run (start + sales) took 22 min on the shared omarchy machine (label SCR2, 20 Nov 2026). Most of that is waiting for the dev server to compile routes and render PDFs, not the driver.

- `--from` and `--only` reload the workflow's records from `state.json`; skipped steps keep their earlier results. What re-running a step that already ran (fully or partly) does:
  - **Never repeats a change** (checks the effect first): start-1 to start-6 (start-2 adopts the memo with this run's exact subject when an attempt stopped before recording it); sales-2, sales-4 (skips upload and submit once the case reads Awaiting review or Verified), sales-5 (skips accepted documents and a verified customer), sales-7 (skips a submitted quotation and each approver already done), sales-8, sales-9 (skips a recorded acceptance), sales-10, sales-11 (skips submit, each approver already done, and an issued invoice), sales-12 and sales-15 (reuse the recorded payment, or adopt the one payment whose bank reference is exactly this run's; a failed lookup, two matches or another payment of this customer fails the step without recording), sales-13, sales-14 (skips the deallocation once its reversal row exists, and the re-allocation once nothing is left on the payment).
  - **Refuses to run again** (fails with a message, changes nothing): sales-1 once the lead exists (recorded, or found in the Leads list by its exact title, whose URL is then recorded), sales-3 once the verification case exists, sales-6 once the quotation exists. A partly done sales-1 (lead created, not yet Qualified) or sales-6 needs a new label.
  - **Remaining gaps:** each `s.record` writes `state.json` at once, so only a stop in the moment between a server-side change and the record right after it is left. For the memo (start-2), the lead (sales-1) and payments (sales-12, sales-15) a re-run closes it by the exact-match lookup. Approvals: if a run stopped between an Approve click and its save, a re-run finds no inbox row; it continues when the record is already past approval (quotation Approved, invoice no longer Awaiting approval) and otherwise fails with a message rather than approve twice. Elsewhere (the conversion in sales-2, the verification case in sales-3, the quotation in sales-6, the sales order and invoice in sales-10 and sales-11) a re-run fails closed: the page no longer offers the action, or the step refuses, and nothing is created twice.
  - Re-run after a later step already ran, a check of the state that later step changed is reported as a note instead of failing (start-4: Finance already approved; sales-7: quotation already Sent or Accepted; sales-12: payment already verified). Other checks still run and can fail.
- The workspace dev server restarts itself under memory pressure, so a run on a loaded machine may need one or two `--from` resumes. The segments together form the run's video.
- The browser print dialog cannot be shown headless. start-3 checks the print frame's content instead of a printed page.
- start-6 masks the one-time code before the sign-in window loads its first page: a stylesheet in every document of that window makes the code input (`input[name=code]`, `-webkit-text-security: disc`, transparent text) and the six visible code boxes (`.bos-otp-slot` inside input-otp's `[data-input-otp-container]`) transparent. Before typing, the step checks the computed style of the input and of every box and fails rather than type the code if there is no box or any is still visible. The login name is visible; the password field is masked by the page itself.
- Portal steps (customer side) are not driven in Phase A.
- No database checks are used. Every assertion goes through the UI, Mailpit or downloaded files.
- The video is the browser viewport only. Native file-chooser windows and downloads are not visible in it.
