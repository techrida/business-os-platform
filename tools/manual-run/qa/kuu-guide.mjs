#!/usr/bin/env node
// Writes round5/guide/QA.html: the round-4 hand checks that the browser run did not cover (NOT-RUN, BLOCKED)
// plus the FAIL rows to re-check, as numbered steps for Kuu. Static HTML, no scripts.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { EVIDENCE } from './harness.mjs';

const rows = JSON.parse(readFileSync(path.join(EVIDENCE, 'results.json'), 'utf8'));
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
const open = rows.filter((r) => r.status === 'NOT-RUN' || r.status === 'BLOCKED');
const out = '/home/crestia/bos-runtimes/round5/guide/QA.html';
mkdirSync(path.dirname(out), { recursive: true });
let n = 0;
let html = `<!doctype html><meta charset=utf-8><title>Round 5 QA: checks left for you</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:50rem;margin:2rem auto;padding:0 1rem;color:#1c1c1c;background:#fff}li{margin:.7rem 0}code{background:#f2f2f2;padding:0 .25rem;border-radius:3px}.n{color:#555}h2{font-size:1.1rem;margin-top:1.6rem}</style>
<h1>Round 5 QA: checks the browser run did not cover</h1>
<p class=n>Stack: bos-testrun at p4-main bc60d7a1, https://app.testrun.localhost:58343 (omarchy). Switch users at /dev/personas; passwords: run <code>logins business-os</code> in a terminal. The wording of each step is the round-4 guide's; the second line says why it was not run. Evidence of everything that was run: <code>/home/crestia/bos-runtimes/round5/evidence/QA/index.html</code>.</p>`;
for (const g of [...new Set(open.map((r) => r.guide))]) {
  html += `<h2>${esc(g)}</h2><ol start="${n + 1}">`;
  for (const r of open.filter((x) => x.guide === g)) {
    n++;
    html += `<li><b>${esc(r.id)}</b> (${esc(r.status)}) ${esc(r.title)}<br><span class=n>${esc(r.reason ?? '')}</span></li>`;
  }
  html += '</ol>';
}
html += `<p class=n>${n} steps.</p>`;
writeFileSync(out, html);
console.log('wrote', out, n, 'steps');
