#!/usr/bin/env node
// node tools/manual-run/qa/fqa3.mjs --sizes desktop[,laptop,tablet,mobile] [--only area-flow,...]
// One recorded clip per flow per size under evidence/FQA3/clips/. The FQA2 flows are reused as they are
// (patched for the round-5 fixes); FQA3 adds the flows in fqa3-flows.mjs.
import './fqa3-env.mjs';
const { runSize, SIZES } = await import('./fqa1-lib.mjs');
const { FLOWS: F1 } = await import('./fqa1-flows.mjs');
const { FLOWS: F2 } = await import('./fqa2-flows.mjs');
const { FQA3_FLOWS } = await import('./fqa3-flows.mjs');

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const sizes = arg('sizes', 'desktop').split(',');
const only = arg('only', '') ? arg('only').split(',') : undefined;
// A flow name is unique: the first definition wins (FQA3, then FQA2, then FQA1), so a part-1 flow that
// FQA2 rewrote for the round-5 UI is never run beside its rewrite.
const all = [];
for (const f of [...FQA3_FLOWS, ...F2, ...F1])
  if (!all.some((g) => g.area === f.area && g.flow === f.flow)) all.push(f);
let bad = 0;
for (const size of sizes) {
  if (!SIZES[size]) throw new Error(`unknown size ${size}; use ${Object.keys(SIZES).join(', ')}`);
  const out = await runSize(size, all, { only });
  for (const r of out) {
    console.log(`${r.guide}: ${r.pass} pass, ${r.fail} fail, clip ${r.clip || 'MISSING'}`);
    bad += r.fail;
  }
}
process.exit(bad ? 1 : 0);
