// Runs dates.tz.test.ts in three server time zones. The date code must not depend on the machine's TZ, so a
// pass in UTC alone proves little; each child process gets its own TZ before Node starts (TZ is read at startup).
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const vitestCli = join(
  dirname(createRequire(import.meta.url).resolve('vitest/package.json')),
  'vitest.mjs',
);

describe('BS dates and fiscal year are independent of the server TZ', () => {
  it.each(['UTC', 'Asia/Kathmandu', 'America/New_York'])(
    'TZ=%s',
    async (TZ) => {
      const env = { ...process.env, TZ, LOCALE_TZ_RUN: '1' };
      let stdout: string;
      try {
        ({ stdout } = await run(process.execPath, [vitestCli, 'run', 'src/dates.tz.test.ts'], {
          cwd: packageRoot,
          env,
        }));
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; code?: number };
        throw new Error(
          `inner run failed (exit ${err.code}) under TZ=${TZ}\n${err.stdout ?? ''}\n${err.stderr ?? ''}`,
        );
      }
      // Exit 0 alone could mean "everything skipped": the inner file must really have run.
      // Vitest colours its summary even when piped, so strip the escape codes before matching.
      // eslint-disable-next-line no-control-regex
      const plain = stdout.replace(/\u001b\[[0-9;]*m/g, '');
      expect(plain).toMatch(/Tests\s+\d+ passed/);
      expect(plain).not.toMatch(/skipped/);
    },
    120_000,
  );
});
