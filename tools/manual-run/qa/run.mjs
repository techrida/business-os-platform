#!/usr/bin/env node
// node tools/manual-run/qa/run.mjs --guides retest,r4a [--viewport 1440x900] [--label qa]
import path from 'node:path';
import { openQA, Recorder, EVIDENCE } from './harness.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const guides = arg('guides', 'retest').split(',');
const qa = await openQA({ label: arg('label', 'qa'), viewport: arg('viewport', '1440x900') });
const rec = new Recorder(path.join(EVIDENCE, 'results.json'));
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const sharedFile = path.join(EVIDENCE, 'shared.json');
const shared = existsSync(sharedFile) ? JSON.parse(readFileSync(sharedFile, 'utf8')) : {};
shared.save = () =>
  writeFileSync(sharedFile, JSON.stringify({ ...shared, save: undefined }, null, 1));
let code = 0;
try {
  for (const g of guides) {
    const mod = await import(`./g-${g}.mjs`);
    await mod.run(qa, rec, shared);
  }
} catch (e) {
  console.error('qa run error:', String(e.message).split('\n')[0]);
  code = 1;
} finally {
  await qa.browser.close().catch(() => {});
}
process.exit(code);
