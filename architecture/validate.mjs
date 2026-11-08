// Checks model.js for broken references. Run: node architecture/validate.mjs [model.js]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const file = process.argv[2] || fileURLToPath(new URL("./model.js", import.meta.url));
const ctx = { window: {} };
vm.runInNewContext(readFileSync(file, "utf8"), ctx);
const M = ctx.window.BOS_MODEL;
const errs = [], warns = [];
const P = M.phases.map((p) => p.id);
const idx = (p) => P.indexOf(p);
const els = new Map();
const KINDS = new Set(["person", "system", "container", "component", "store", "external", "worker", "later"]);

for (const e of M.elements) {
  if (els.has(e.id)) errs.push(`duplicate element ${e.id}`);
  els.set(e.id, e);
  if (!KINDS.has(e.kind)) errs.push(`${e.id}: bad kind ${e.kind}`);
  if (idx(e.since) < 0) errs.push(`${e.id}: bad since ${e.since}`);
  if (e.until && idx(e.until) <= idx(e.since)) errs.push(`${e.id}: until must be after since`);
  for (const k of Object.keys(e.changes || {})) if (idx(k) <= idx(e.since)) errs.push(`${e.id}: change in ${k} is not after since`);
}
for (const e of M.elements) {
  if (e.parent == null) continue;
  const p = els.get(e.parent);
  if (!p) { errs.push(`${e.id}: missing parent ${e.parent}`); continue; }
  if (idx(e.since) < idx(p.since)) errs.push(`${e.id}: exists (${e.since}) before its parent ${p.id} (${p.since})`);
}
// relation checks
const live = (x, i) => idx(x.since) <= i && (!x.until || i < idx(x.until));
const pairs = new Map();
const relIds = new Set();
for (const r of M.relations) {
  if (relIds.has(r.id)) errs.push(`duplicate relation ${r.id}`);
  relIds.add(r.id);
  const a = els.get(r.src), b = els.get(r.dst);
  if (!a || !b) { errs.push(`${r.id}: missing end ${!a ? r.src : r.dst}`); continue; }
  if (idx(r.since) < Math.max(idx(a.since), idx(b.since))) errs.push(`${r.id} ${r.src}→${r.dst}: since ${r.since} before an end exists`);
  if (a.until && (!r.until || idx(r.until) > idx(a.until))) errs.push(`${r.id}: outlives ${a.id}`);
  if (b.until && (!r.until || idx(r.until) > idx(b.until))) errs.push(`${r.id}: outlives ${b.id}`);
  const isAnc = (x, y) => { for (let p = els.get(y)?.parent; p; p = els.get(p)?.parent) if (p === x) return true; return false; };
  if (isAnc(r.src, r.dst) || isAnc(r.dst, r.src)) errs.push(`${r.id}: links an element to its own ancestor`);
  const hasKids = (id) => M.elements.some((e) => e.parent === id);
  if (hasKids(r.src) || hasKids(r.dst)) warns.push(`${r.id} ${r.src}→${r.dst}: an end is a section (prefer leaves)`);
  const k = r.src + ">" + r.dst;
  if (pairs.has(k)) warns.push(`${r.id}: same pair as ${pairs.get(k)}`);
  pairs.set(k, r.id);
}
// flows
for (const f of M.flows) {
  const i = idx(f.since);
  if (i < 0) errs.push(`flow ${f.id}: bad since`);
  f.steps.forEach((s, n) => {
    for (const id of [s.src, s.dst]) {
      const e = els.get(id);
      if (!e) errs.push(`flow ${f.id} step ${n + 1}: missing ${id}`);
      else if (!live(e, i)) errs.push(`flow ${f.id} step ${n + 1}: ${id} does not exist at ${f.since}`);
    }
    const r = M.relations.find((r) => (r.src === s.src && r.dst === s.dst) || (r.src === s.dst && r.dst === s.src));
    if (!r) errs.push(`flow ${f.id} step ${n + 1}: no relation ${s.src}→${s.dst}`);
    else if (!live(r, i)) errs.push(`flow ${f.id} step ${n + 1}: relation ${r.id} not live at ${f.since}`);
  });
}
// orphans
const linked = new Set(M.relations.flatMap((r) => [r.src, r.dst]));
for (const e of M.elements) {
  const leaf = !M.elements.some((c) => c.parent === e.id);
  if (leaf && !linked.has(e.id) && e.kind !== "later") warns.push(`${e.id}: no arrows`);
}
const perPhase = P.map((p, i) => `${p}:${M.elements.filter((e) => live(e, i)).length}el/${M.relations.filter((r) => live(r, i)).length}rel`).join(" ");
console.log(`${M.elements.length} elements, ${M.relations.length} relations, ${M.flows.length} flows | ${perPhase}`);
for (const w of warns) console.log("warn  " + w);
for (const e of errs) console.log("ERROR " + e);
process.exit(errs.length ? 1 : 0);
