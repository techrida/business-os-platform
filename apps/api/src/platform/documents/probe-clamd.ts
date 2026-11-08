// Probe against a REAL clamd (the lead runs it after `pnpm stack:up:files`). Not a test and not imported by the app.
//
//   cd apps/api && CLAMD_HOST=127.0.0.1 CLAMD_PORT=3310 pnpm exec tsx src/platform/documents/probe-clamd.ts
//
// It proves four things the fake clamd cannot: the real daemon answers PING and VERSION, it says OK for
// harmless bytes, it says FOUND for the EICAR test bytes, and it still finds EICAR when the bytes arrive split
// across INSTREAM chunks. EICAR stays in memory: it is never written to disk (Defender would quarantine it).
// Exit code 0 = all passed. The last line of output is one JSON object.
import { Readable } from 'node:stream';

import { ClamdClient } from './clamd.client';
import { eicarBytes } from './fake-clamd';

const host = process.env['CLAMD_HOST'] ?? '127.0.0.1';
const port = Number(process.env['CLAMD_PORT'] ?? '3310');

async function main(): Promise<void> {
  // 120 s idle limit: right after a cold start clamd can take a while to answer while it loads signatures.
  const clamd = new ClamdClient({ host, port, timeoutMs: 120_000 });
  const results: Record<string, unknown> = { host, port };
  let failed = false;
  const check = (name: string, ok: boolean, detail?: unknown): void => {
    results[name] = ok ? 'pass' : { fail: detail ?? 'unexpected result' };
    if (!ok) failed = true;
    console.error(
      `[probe] ${ok ? 'PASS' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `: ${JSON.stringify(detail)}`}`,
    );
  };

  const ping = await clamd.ping();
  check('ping', ping);
  if (ping) {
    const version = await clamd.version();
    results['version'] = version;
    console.error(`[probe] clamd version: ${version}`);
    check('version', /^ClamAV \d/.test(version), version);
  }

  const clean = await clamd.scan(Readable.from([Buffer.from('an ordinary harmless file\n')]));
  check('clean_bytes_are_ok', clean.verdict === 'clean', clean);

  const eicar = eicarBytes();
  const whole = await clamd.scan(Readable.from([eicar]));
  check('eicar_is_found', whole.verdict === 'infected', whole);
  results['eicar_signature'] = whole.signature;

  // No padding around the halves: the EICAR standard only counts the string at offset 0 of a file,
  // and real ClamAV says OK for "prefix-" + EICAR (seen 2026-11-08). Only the chunk boundary is tested.
  const cut = 31;
  const split = await clamd.scan(Readable.from([eicar.subarray(0, cut), eicar.subarray(cut)]));
  check('eicar_found_when_split_across_chunks', split.verdict === 'infected', split);

  console.log(JSON.stringify({ result: failed ? 'fail' : 'pass', ...results }));
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.log(
    JSON.stringify({ result: 'fail', error: error instanceof Error ? error.message : 'unknown' }),
  );
  process.exit(1);
});
