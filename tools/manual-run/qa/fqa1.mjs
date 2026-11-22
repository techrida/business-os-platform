#!/usr/bin/env node
// node tools/manual-run/qa/fqa1.mjs --sizes desktop[,laptop,tablet,mobile] [--only area-flow,...]
// One recorded clip per flow per size under evidence/FQA1/clips/. See fqa1-lib.mjs and fqa1-flows.mjs.
import { runSize, SIZES } from './fqa1-lib.mjs';
import { FLOWS } from './fqa1-flows.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const sizes = arg('sizes', 'desktop').split(',');
const only = arg('only', '') ? arg('only').split(',') : undefined;
let bad = 0;
for (const size of sizes) {
  if (!SIZES[size]) throw new Error(`unknown size ${size}; use ${Object.keys(SIZES).join(', ')}`);
  const out = await runSize(size, FLOWS, { only });
  for (const r of out) {
    console.log(`${r.guide}: ${r.pass} pass, ${r.fail} fail, clip ${r.clip || 'MISSING'}`);
    bad += r.fail;
  }
}
process.exit(bad ? 1 : 0);
