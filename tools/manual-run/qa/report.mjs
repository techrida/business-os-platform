#!/usr/bin/env node
// Builds evidence/QA/index.html and results.md from results.json (+ fgq2/manifest.json). Static HTML, no scripts.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { EVIDENCE } from './harness.mjs';

const rows = JSON.parse(readFileSync(path.join(EVIDENCE, 'results.json'), 'utf8'));
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c],
  );
const guides = [...new Set(rows.map((r) => r.guide))];
const count = (g, st) => rows.filter((r) => r.guide === g && r.status === st).length;
let md =
  '# Round-5 QA results\n\n| Guide | PASS | FAIL | BLOCKED | NOT-RUN |\n|---|---|---|---|---|\n';
let html = `<!doctype html><meta charset=utf-8><title>Round 5 QA evidence</title><style>body{font:15px/1.45 system-ui,sans-serif;max-width:70rem;margin:2rem auto;padding:0 1rem;color:#1c1c1c;background:#fff}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:.3rem .5rem;vertical-align:top;text-align:left}.PASS{color:#0a6b2d}.FAIL{color:#b00020;font-weight:700}.BLOCKED,.NOT-RUN{color:#8a5a00}code{background:#f2f2f2;padding:0 .2rem}ul{margin:.2rem 0;padding-left:1.1rem}</style><h1>Business OS round 5: unit QA</h1>`;
html += '<h2>Totals</h2><table><tr><th>Guide<th>PASS<th>FAIL<th>BLOCKED<th>NOT-RUN</tr>';
for (const g of guides) {
  md += `| ${g} | ${count(g, 'PASS')} | ${count(g, 'FAIL')} | ${count(g, 'BLOCKED')} | ${count(g, 'NOT-RUN')} |\n`;
  html += `<tr><td>${g}<td>${count(g, 'PASS')}<td>${count(g, 'FAIL')}<td>${count(g, 'BLOCKED')}<td>${count(g, 'NOT-RUN')}</tr>`;
}
html += '</table>';
for (const g of guides) {
  md += `\n## ${g}\n\n`;
  html += `<h2>${g}</h2><table><tr><th>Step<th>Status<th>What was checked<th>Persona / URL<th>Controls asserted / reason<th>Screenshot</tr>`;
  for (const r of rows.filter((x) => x.guide === g)) {
    const shot = r.shot ? path.relative(EVIDENCE, r.shot) : '';
    md += `- **${r.id}** ${r.status}: ${r.title}${r.error ? ` — ${r.error}` : ''}${r.reason ? ` — ${r.reason}` : ''}${r.status === 'FAIL' && r.classify ? ` [${r.classify}]` : ''}${shot ? ` (${shot})` : ''}\n`;
    html += `<tr><td>${esc(r.id)}<td class="${esc(r.status)}">${esc(r.status)}<td>${esc(r.title)}${r.status === 'FAIL' && r.classify ? `<br><b>${esc(r.classify)}</b>` : ''}<td>${esc(r.persona ?? '')}<br><code>${esc(r.url ?? '')}</code><td>`;
    if (r.error) html += `<b>${esc(r.error)}</b><br>`;
    if (r.reason) html += esc(r.reason);
    if (r.controls?.length)
      html += `<ul>${r.controls.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`;
    html += `<td>${shot ? `<a href="${esc(shot)}">${esc(shot)}</a>` : ''}</tr>`;
  }
  html += '</table>';
}
const fg = path.join(EVIDENCE, 'fgq2', 'manifest.json');
if (existsSync(fg)) {
  const m = JSON.parse(readFileSync(fg, 'utf8'));
  html += `<h2>FG-Q2 captures (${m.length})</h2><table><tr><th>Slug<th>Role<th>Status<th>Desktop<th>Mobile<th>Note</tr>`;
  for (const r of m)
    html += `<tr><td>${esc(r.slug)}<td>${esc(r.role)}<td class="${r.status === 'captured' ? 'PASS' : 'FAIL'}">${esc(r.status)}<td>${r.desktop ? `<a href="fgq2/${esc(r.desktop)}">${esc(r.desktop)}</a>` : ''}<td>${r.mobile ? `<a href="fgq2/${esc(r.mobile)}">${esc(r.mobile)}</a>` : ''}<td>${esc(r.note)}</tr>`;
  html += '</table>';
  if (existsSync(path.join(EVIDENCE, 'fgq2-gaps.md')))
    html += '<p>Gap list: <a href="fgq2-gaps.md">fgq2-gaps.md</a></p>';
}
writeFileSync(path.join(EVIDENCE, 'index.html'), html);
writeFileSync(path.join(EVIDENCE, 'results.md'), md);
console.log('wrote index.html and results.md', rows.length, 'rows');
