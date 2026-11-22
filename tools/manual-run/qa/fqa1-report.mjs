#!/usr/bin/env node
// Builds evidence/FQA1/index.html and results.md from results.json, issues.md, scope.md and the clips folder.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { FQA, SIZES } from './fqa1-lib.mjs';

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
const rows = JSON.parse(readFileSync(path.join(FQA, 'results.json'), 'utf8')).filter(
  (r) => r.size && r.flow && r.id !== '3-decided',
);
const sizes = Object.keys(SIZES);
const flows = [...new Set(rows.map((r) => `${r.area}-${r.flow}`))].sort();
const clips = new Set(
  existsSync(path.join(FQA, 'clips')) ? readdirSync(path.join(FQA, 'clips')) : [],
);
const by = (flow, size) => rows.filter((r) => `${r.area}-${r.flow}` === flow && r.size === size);
const tally = (rs) => ({
  p: rs.filter((r) => r.status === 'PASS').length,
  f: rs.filter((r) => r.status === 'FAIL').length,
});

let md =
  '# FQA1 results\n\n| Flow | ' +
  sizes.join(' | ') +
  ' |\n|---|' +
  sizes.map(() => '---').join('|') +
  '|\n';
let html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>FQA1 final QA part 1</title>
<style>:root{--bg:#fff;--fg:#14213d;--mut:#5b6478;--ok:#0b7a3b;--bad:#b3261e;--line:#dfe3ec}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;padding:16px;max-width:1200px;margin-inline:auto}
table{border-collapse:collapse;width:100%;margin:12px 0}td,th{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}.ok{color:var(--ok);font-weight:600}.bad{color:var(--bad);font-weight:600}.mut{color:var(--mut)}details{margin:6px 0}code{font-size:13px}pre{white-space:pre-wrap;background:#f6f7fb;padding:8px;border-radius:6px}</style></head><body>
<h1>FQA1: final QA part 1</h1><p class="mut">bos-testrun at p4-main ecf74fabe, compiled devtools build. Generated ${new Date().toISOString()}.</p>
<h2>PASS / FAIL by flow and size</h2><table><tr><th>Flow</th>${sizes.map((s) => `<th>${s} ${SIZES[s]}</th>`).join('')}</tr>`;
for (const f of flows) {
  html += `<tr><th>${esc(f)}</th>`;
  md += `| ${f} |`;
  for (const s of sizes) {
    const rs = by(f, s);
    if (!rs.length) {
      html += '<td class="mut">not run</td>';
      md += ' not run |';
      continue;
    }
    const t = tally(rs);
    const clip = `${f}-${s}.webm`;
    html += `<td><span class="${t.f ? 'bad' : 'ok'}">${t.p} pass, ${t.f} fail</span>${clips.has(clip) ? ` · <a href="clips/${clip}">clip</a>` : ''}</td>`;
    md += ` ${t.p}/${t.f} |`;
  }
  html += '</tr>';
  md += '\n';
}
html += '</table><h2>Steps</h2>';
for (const f of flows)
  for (const s of sizes) {
    const rs = by(f, s);
    if (!rs.length) continue;
    html += `<details><summary><b>${esc(f)}</b> at ${s}</summary>${clips.has(`${f}-${s}.webm`) ? `<video controls preload="none" width="480" src="clips/${f}-${s}.webm"></video>` : ''}<table><tr><th>Step</th><th>Status</th><th>Persona</th><th>Controls asserted</th><th>Clip at</th><th>Shot</th></tr>`;
    for (const r of rs.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true })))
      html += `<tr><td>${esc(r.id)} ${esc(r.title)}${r.error ? `<br><span class="bad">${esc(r.error)}<br>repro: ${esc(r.persona)}, ${esc(r.url)}</span>` : ''}</td><td class="${r.status === 'PASS' ? 'ok' : 'bad'}">${r.status}</td><td>${esc(r.persona)}</td><td>${r.controls.map((c) => esc(c)).join('<br>')}</td><td>${r.clipAt}s</td><td>${r.shot ? `<a href="${esc(path.relative(FQA, r.shot))}">png</a>` : ''}</td></tr>`;
    html += '</table></details>';
  }
for (const [title, file] of [
  ['Issue log', 'issues.md'],
  ['Scope table', 'scope.md'],
  ['Side effects ledger', 'side-effects.jsonl'],
])
  if (existsSync(path.join(FQA, file)))
    html += `<h2>${title}</h2><pre>${esc(readFileSync(path.join(FQA, file), 'utf8'))}</pre>`;
html += '</body></html>';
writeFileSync(path.join(FQA, 'index.html'), html);
writeFileSync(path.join(FQA, 'results.md'), md);
console.log(`wrote index.html (${rows.length} step rows, ${flows.length} flows)`);
